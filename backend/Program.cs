using GdPicture14;
using GdPicture14.Imaging;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
});

var app = builder.Build();
app.UseCors();

// GdPicture license from the environment. An empty key starts evaluation mode
// (RegisterKEY must still be called).
var licenseManager = new LicenseManager();
licenseManager.RegisterKEY(Environment.GetEnvironmentVariable("GDPICTURE_LICENSE_KEY") ?? "");

app.MapPost("/api/extract-text", async (HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    ms.Position = 0;

    var pdf = new GdPicturePDF();
    var status = pdf.LoadFromStream(ms, false);
    if (status != GdPictureStatus.OK)
        return Results.BadRequest(new { error = $"Failed to load PDF: {status}" });

    var pages = new List<object>();
    int pageCount = pdf.GetPageCount();

    for (int p = 1; p <= pageCount; p++)
    {
        pdf.SelectPage(p);
        float pageWidth = pdf.GetPageWidth();
        float pageHeight = pdf.GetPageHeight();
        string rawText = pdf.GetPageText();
        string coordsText = pdf.GetPageTextWithCoords("\t");

        var words = new List<object>();
        if (!string.IsNullOrEmpty(coordsText))
        {
            var lines = coordsText.Split('\n', StringSplitOptions.RemoveEmptyEntries);
            foreach (var line in lines)
            {
                var fields = line.Split('\t');
                // Format: x1,y1, x2,y2, x3,y3, x4,y4, text, fontName, fontBoxHeight, textMode, textSize
                if (fields.Length >= 13)
                {
                    words.Add(new
                    {
                        // Top-left
                        x1 = float.TryParse(fields[0], out var v0) ? v0 : 0f,
                        y1 = float.TryParse(fields[1], out var v1) ? v1 : 0f,
                        // Top-right
                        x2 = float.TryParse(fields[2], out var v2) ? v2 : 0f,
                        y2 = float.TryParse(fields[3], out var v3) ? v3 : 0f,
                        // Bottom-right
                        x3 = float.TryParse(fields[4], out var v4) ? v4 : 0f,
                        y3 = float.TryParse(fields[5], out var v5) ? v5 : 0f,
                        // Bottom-left
                        x4 = float.TryParse(fields[6], out var v6) ? v6 : 0f,
                        y4 = float.TryParse(fields[7], out var v7) ? v7 : 0f,
                        text = fields[8],
                        fontName = fields[9],
                        fontBoxHeight = float.TryParse(fields[10], out var v10) ? v10 : 0f,
                        textMode = fields[11],
                        textSize = float.TryParse(fields[12], out var v12) ? v12 : 0f,
                    });
                }
            }
        }

        pages.Add(new
        {
            pageNumber = p,
            width = pageWidth,
            height = pageHeight,
            text = rawText,
            words
        });
    }

    pdf.CloseDocument();
    pdf.Dispose();

    return Results.Ok(new { pageCount, pages });
});

app.MapPost("/api/search-text", async (HttpRequest request) =>
{
    var body = await JsonSerializer.DeserializeAsync<JsonElement>(request.Body);
    var pdfBase64 = body.GetProperty("pdf").GetString()!;
    var searchText = body.GetProperty("text").GetString()!;

    var pdfBytes = Convert.FromBase64String(pdfBase64);
    using var ms = new MemoryStream(pdfBytes);

    var pdf = new GdPicturePDF();
    var status = pdf.LoadFromStream(ms, false);
    if (status != GdPictureStatus.OK)
        return Results.BadRequest(new { error = $"Failed to load PDF: {status}" });

    var results = new List<object>();
    int pageCount = pdf.GetPageCount();

    for (int p = 1; p <= pageCount; p++)
    {
        pdf.SelectPage(p);
        float pageWidth = pdf.GetPageWidth();
        float pageHeight = pdf.GetPageHeight();

        int occurrence = 0;
        while (true)
        {
            GdPictureRectangleF[]? boundingBoxes = null;
            bool found = pdf.SearchText(searchText, occurrence, false, false, false, false, ref boundingBoxes);
            if (!found || boundingBoxes == null) break;

            foreach (var box in boundingBoxes)
            {
                results.Add(new
                {
                    pageNumber = p,
                    pageWidth,
                    pageHeight,
                    left = box.Left,
                    top = box.Top,
                    width = box.Width,
                    height = box.Height
                });
            }
            occurrence++;
        }
    }

    pdf.CloseDocument();
    pdf.Dispose();

    return Results.Ok(new { matches = results });
});

app.MapPost("/api/grammar-check", async (HttpRequest request) =>
{
    var body = await JsonSerializer.DeserializeAsync<JsonElement>(request.Body);
    var text = body.GetProperty("text").GetString()!;

    // Simulated grammar check: a small rule list. To use a real grammar or
    // spelling service, call its API here and map each finding to
    // { offset, length, message, suggestion, category, text }.
    var issues = SimulateGrammarCheck(text);

    return Results.Ok(new { issues });
});

app.Run();

static List<object> SimulateGrammarCheck(string text)
{
    var issues = new List<object>();
    var rules = new (string pattern, string message, string suggestion, string category)[]
    {
        ("teh", "Misspelling: 'teh' should be 'the'", "the", "spelling"),
        ("recieve", "Misspelling: 'recieve' should be 'receive'", "receive", "spelling"),
        ("occured", "Misspelling: 'occured' should be 'occurred'", "occurred", "spelling"),
        ("definately", "Misspelling: 'definately' should be 'definitely'", "definitely", "spelling"),
        ("seperate", "Misspelling: 'seperate' should be 'separate'", "separate", "spelling"),
        ("accomodate", "Misspelling: 'accomodate' should be 'accommodate'", "accommodate", "spelling"),
        ("  ", "Double space detected", " ", "style"),
        ("very unique", "'Unique' is absolute; 'very unique' is redundant", "unique", "style"),
        ("in order to", "Wordy: 'in order to' can be simplified", "to", "style"),
        ("at this point in time", "Wordy: 'at this point in time' can be simplified", "now", "style"),
        ("due to the fact that", "Wordy: 'due to the fact that' can be simplified", "because", "style"),
        ("utilize", "'Utilize' is often pretentious; prefer 'use'", "use", "style"),
        ("irregardless", "'Irregardless' is not standard; use 'regardless'", "regardless", "grammar"),
        ("could of", "'Could of' should be 'could have'", "could have", "grammar"),
        ("should of", "'Should of' should be 'should have'", "should have", "grammar"),
        ("would of", "'Would of' should be 'would have'", "would have", "grammar"),
        ("alot", "'Alot' is not a word; use 'a lot'", "a lot", "spelling"),
        ("its a", "Missing apostrophe: 'its a' should be 'it's a'", "it's a", "grammar"),
        ("their is", "'Their is' should be 'there is'", "there is", "grammar"),
        ("your a", "'Your a' should be 'you're a'", "you're a", "grammar"),
    };

    foreach (var (pattern, message, suggestion, category) in rules)
    {
        var idx = 0;
        while ((idx = text.IndexOf(pattern, idx, StringComparison.OrdinalIgnoreCase)) >= 0)
        {
            int end = idx + pattern.Length;
            // A match starts a word. Phrases also end one, so "your a" does not match the
            // start of "your application"; single words may take a suffix ("recieved").
            bool insideWord = (char.IsLetter(pattern[0]) && idx > 0 && char.IsLetter(text[idx - 1]))
                || (pattern.Contains(' ') && char.IsLetter(pattern[^1]) && end < text.Length && char.IsLetter(text[end]));
            if (!insideWord)
            {
                var found = text.Substring(idx, pattern.Length);
                // Keep the capital letter of a sentence start ("In order to" becomes "To").
                var fix = char.IsUpper(found[0]) && suggestion.Length > 0
                    ? char.ToUpperInvariant(suggestion[0]) + suggestion[1..]
                    : suggestion;
                issues.Add(new
                {
                    offset = idx,
                    length = pattern.Length,
                    message,
                    suggestion = fix,
                    category,
                    text = found
                });
            }
            idx = end;
        }
    }

    return issues.OrderBy(i => ((dynamic)i).offset).ToList();
}
