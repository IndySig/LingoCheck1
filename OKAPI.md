# Okapi integration (DOCX layout + SRX segmentation)

LingoCheck uses [Okapi Tikal](https://okapiframework.org/wiki/index.php/Tikal) for Word documents:

1. **Extract** DOCX → XLIFF (+ skeleton) with default SRX segmentation  
2. **Translate** the XLIFF segments (reviewer rows = SRX sentences)  
3. **Merge** XLIFF → DOCX so the original layout is restored  

PDF / TXT / MD still use the previous browser parsers.

## Setup

### Local (Windows)

```powershell
npm run setup:okapi
.\start-lingocheck.ps1
```

### Local / Render (Linux)

```bash
npm run build   # downloads JRE + Okapi into .tools/
npm start
```

On Render, set:

- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`

(see `render.yaml`). `npm start` also auto-installs Okapi if the build step was skipped. Set `ANTHROPIC_API_KEY` (and other secrets) in the Render dashboard — `auth.local.json` is not deployed. First boot may take a few minutes while Java/Okapi download.

You should see in logs: `Okapi Tikal ready (...)`.

This downloads:

- Eclipse Temurin 17 JRE → `.tools/jre`
- Okapi apps 1.48.0 → `.tools/okapi`

`.tools/` is gitignored; each environment installs its own copy at build/setup time.

### Manual install

Set environment variables (or place tools under `.tools/` as above):

- `JAVA_HOME` — Java 11+  
- `OKAPI_HOME` — folder containing `tikal.bat` / `tikal.sh`

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/okapi/status` | Ready check |
| `POST /api/okapi/extract` | DOCX → text + sentences + XLIFF package |
| `POST /api/okapi/merge` | XLIFF + translations → DOCX |

If Okapi is unavailable, DOCX upload/download falls back to the browser parser / styled template.

## Notes

- Source language is treated as English; target is Dutch / Spanish / German.  
- Inline formatting inside a run may still simplify; paragraph/table structure is preserved.  
- Large binaries live in `.tools/` (gitignored).  
