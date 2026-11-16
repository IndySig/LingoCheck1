# Smoke-tests LingoCheck

Korte check of de app werkt voor **klanten** én **revisoren**. Geen echte AI-key nodig (demo-modus is ok).

| Soort check | Waar |
|-------------|------|
| **Handmatig** (browser, voor niet-technische tester) | [HANDLEIDING.md](HANDLEIDING.md) |
| **Automatisch** | `npm run smoke` (dit document) |

## Snel starten (lokaal)

1. Start de server in één terminal:

```bash
npm start
```

Op Windows kun je ook `.\start-lingocheck.ps1` gebruiken (poort **5001**).

> `npm start` luistert standaard op poort **5000** (`PORT` env).  
> Het smoke-script verwacht standaard **5001** (zoals het PowerShell-script).  
> Stem ze af, bijvoorbeeld: `PORT=5001 npm start`

2. In een tweede terminal:

```bash
npm run smoke
```

Of: `npm run smoke:flows`

## Tegen een andere URL (bijv. Render)

```bash
BASE_URL=https://jouw-app.onrender.com npm run smoke
```

## Server automatisch starten

Als de server nog niet draait:

```bash
SMOKE_START=1 PORT=5001 npm run smoke
```

(`SMOKE_START=1` start `server.js` als child-process; default: server moet al draaien.)

## Wat wordt getest?

- Pagina’s: `/`, `/login`, `/privacy`, `/about`, `/revisor`
- Client: challenge → job aanmaken → jobs ophalen → reply → correctieronde
- Revisor: signup → 2FA → claim → vraag → complete → finance → account → logout
- Extra: 401 zonder cookie, 404 bij verkeerde `clientId`
- Soft: `/api/qa-check`, `/api/translate`, forgot-password (WARN/SKIP i.p.v. harde fail als AI-key ontbreekt)

## Testdata

Smoke-jobs gebruiken `clientId` met prefix `smoke_` en revisors `smoke-revisor-<timestamp>@example.com`.  
Er is **geen delete-API**; testdata blijft staan. Dat is bewust — herkenbaar aan de `smoke_`-prefix.

`SMOKE_KEEP=1` (default-gedrag): laat alles staan.

## Exit codes

| Code | Betekenis        |
|------|------------------|
| 0    | Alles groen      |
| 1    | Een of meer FAIL |
| 2    | Server niet bereikbaar |

Groene regels = PASS, rode = FAIL, gele = SKIP/WARN.
