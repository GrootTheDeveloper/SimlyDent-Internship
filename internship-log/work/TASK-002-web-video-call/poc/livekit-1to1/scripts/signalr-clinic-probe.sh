#!/usr/bin/env bash
# Deterministic SignalR clinic isolation probe (run on VPS with Docker).
# Verifies B1 (clinic-b) does not receive CallUpdated for A1→A2 (clinic-a).
set -euo pipefail

API="${1:-https://103.28.32.118.sslip.io}"
PASSWORD="${2:-Demo@123}"

login() {
  local u=$1
  curl -sS -X POST "$API/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"userId\":\"$u\",\"password\":\"$PASSWORD\"}" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])'
}

echo "Logging in A1/A2/B1 against $API ..."
TA1=$(login A1)
TA2=$(login A2)
TB1=$(login B1)

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

cat > "$WORKDIR/SignalRProbe.csproj" <<'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client" Version="8.0.11" />
  </ItemGroup>
</Project>
EOF

cat > "$WORKDIR/Program.cs" <<'EOF'
using Microsoft.AspNetCore.SignalR.Client;

var api = args[0].TrimEnd('/');
var tokenB1 = args[1];
var tokenA1 = args[2];
var tokenA2 = args[3];

using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(60));
var b1GotCall = false;
var a2GotCall = false;

async Task<HubConnection> Connect(string token)
{
    var hub = new HubConnectionBuilder()
        .WithUrl($"{api}/hubs/calls?access_token={Uri.EscapeDataString(token)}")
        .WithAutomaticReconnect()
        .Build();
    await hub.StartAsync(cts.Token);
    return hub;
}

await using var hubB1 = await Connect(tokenB1);
await using var hubA2 = await Connect(tokenA2);

hubB1.On<object>("CallUpdated", _ => { b1GotCall = true; });
hubA2.On<object>("CallUpdated", _ => { a2GotCall = true; });
await Task.Delay(1000, cts.Token);

using var http = new HttpClient();
http.DefaultRequestHeaders.Authorization =
    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", tokenA1);
var createRes = await http.PostAsync(
    $"{api}/api/calls",
    new StringContent("{\"calleeId\":\"A2\"}", System.Text.Encoding.UTF8, "application/json"),
    cts.Token);
var createBody = await createRes.Content.ReadAsStringAsync(cts.Token);
if (!createRes.IsSuccessStatusCode)
{
    Console.WriteLine($"CREATE_FAIL {(int)createRes.StatusCode} {createBody}");
    Environment.Exit(2);
}

var deadline = DateTime.UtcNow.AddSeconds(10);
while (DateTime.UtcNow < deadline && !a2GotCall)
    await Task.Delay(100, cts.Token);
await Task.Delay(2000, cts.Token);

try
{
    using var doc = System.Text.Json.JsonDocument.Parse(createBody);
    var id = doc.RootElement.GetProperty("id").GetString();
    await http.PostAsync($"{api}/api/calls/{id}/cancel", content: null, cts.Token);
}
catch { /* best-effort cleanup */ }

if (!a2GotCall)
{
    Console.WriteLine("FAIL a2_did_not_receive");
    Environment.Exit(3);
}
if (b1GotCall)
{
    Console.WriteLine("FAIL b1_received_cross_clinic_event");
    Environment.Exit(4);
}
Console.WriteLine("PASS signalr_clinic_isolated");
EOF

echo "Running SignalR probe via dotnet SDK container..."
docker run --rm \
  -v "$WORKDIR":/src \
  -w /src \
  mcr.microsoft.com/dotnet/sdk:8.0 \
  bash -lc "dotnet restore -v q && dotnet run -c Release --no-restore -- '$API' '$TB1' '$TA1' '$TA2'"
