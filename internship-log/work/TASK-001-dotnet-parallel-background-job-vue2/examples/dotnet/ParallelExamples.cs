using System;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

public static class ParallelExamples
{
    public static int[] CountAllDivisors(
        int[] input,
        CancellationToken cancellationToken)
    {
        var result = new int[input.Length];
        var options = new ParallelOptions
        {
            CancellationToken = cancellationToken,
            MaxDegreeOfParallelism = Environment.ProcessorCount
        };

        Parallel.For(0, input.Length, options, index =>
        {
            result[index] = CountDivisors(input[index]);
        });

        return result;
    }

    public static async Task<string[]> DownloadAllAsync(
        HttpClient client,
        Uri[] urls,
        int maxConcurrency,
        CancellationToken cancellationToken)
    {
        if (maxConcurrency < 1)
            throw new ArgumentOutOfRangeException(nameof(maxConcurrency));

        var result = new string[urls.Length];
        var options = new ParallelOptions
        {
            CancellationToken = cancellationToken,
            MaxDegreeOfParallelism = maxConcurrency
        };

        await Parallel.ForEachAsync(
            Enumerable.Range(0, urls.Length), options,
            async (index, token) =>
            {
                result[index] =
                    await client.GetStringAsync(urls[index], token);
            });

        return result;
    }

    private static int CountDivisors(int number) =>
        Enumerable.Range(1, number)
            .Count(divisor => number % divisor == 0);
}
