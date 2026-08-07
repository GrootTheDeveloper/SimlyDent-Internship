using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;

namespace LiveKitPoc.Api;

public static class AuthEndpoints
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/auth/accounts", (IdentityRegistry registry) =>
            Results.Ok(registry.Directory(includeLoadUsers: false).Select(ApiAuthMapping.ToUserDto)));

        app.MapPost("/api/auth/login", async (
            HttpRequest request,
            IdentityRegistry identities,
            AuthTokenService tokens) =>
        {
            LoginRequest? body;
            try
            {
                body = await JsonSerializer.DeserializeAsync<LoginRequest>(request.Body, JsonOpts);
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = "Invalid JSON body.", detail = ex.Message }, statusCode: 400);
            }
            if (body is null || string.IsNullOrWhiteSpace(body.UserId))
                return Results.Json(new { error = "userId and password required." }, statusCode: 400);

            if (!identities.TryAuthenticate(body.UserId, body.Password, out var user) || user is null)
                return Results.Json(new { error = "Sai tài khoản hoặc mật khẩu." }, statusCode: 401);

            var (accessToken, expiresAt) = tokens.CreateAccessToken(user);
            return Results.Ok(new LoginResponse(accessToken, expiresAt, ApiAuthMapping.ToUserDto(user)));
        });

        app.MapGet("/api/auth/me", (ClaimsPrincipal principal, IdentityRegistry identities) =>
        {
            var user = ClinicAuthorization.CurrentUser(principal, identities);
            return user is null
                ? Results.Unauthorized()
                : Results.Ok(ApiAuthMapping.ToUserDto(user));
        }).RequireAuthorization();

        return app;
    }
}