The application could be used by request to the server:

- Run `npm start`
- Call http://localhost:9998

## GIST Configuration

[Create a new empty gist file](https://gist.github.com/) (`last-alert.json` with empty object) and [generate a access token](https://github.com/settings/tokens/new?scopes=gist), then put proper values in `GIST_TOKEN` and `GIST_ID` environment variables.

## Environment variables:

- `PORT` - HTTP port (default `9998` if unset)
- `MESSENGER_EMAIL` - Email address of the Messenger user
- `MESSENGER_PASSWORD` - Password of the Messenger user
- `MESSENGER_CONVERSATION_URL` - URL of the conversation to send messages
- `MESSENGER_DEBUG` - `1` / `true` — zrzuty PNG + HTML do `.data/messenger-debug/<timestamp>/` (kroki Messengera)
- `MESSENGER_DEBUG_DIR` - opcjonalnie inny katalog zamiast `.data/messenger-debug`
- `MESSENGER_USER_DATA_DIR` - profil Chromium (sesja FB); domyślnie `.data/puppeteer-messenger`
- `MESSENGER_FB_LOGIN_BUTTON_SELECTOR` - opcjonalnie własny selektor przycisku logowania (Comet UI)
- `MESSENGER_COOKIE_ACCEPT_SELECTOR` - opcjonalnie własny przycisk „wszystkie cookies” przed logowaniem
- `MESSENGER_HEADLESS` - `false` / `0` — widoczne okno Chromium (np. jednorazowo: kod z maila, 2FA); domyślnie headless
- `EREMIZA_LOGIN` - Login to the e-Remiza account which has permissions to read all alerts data
- `EREMIZA_PASSWORD` - Password to the e-Remiza account
- `EREMIZA_SESSION_REFRESH_MS` - po ilu ms wymusić ponowne logowanie (domyślnie `540000` = 9 min; sesja serwera ~10 min)
- `EREMIZA_USER_DATA_DIR` - profil Chromium dla e-Remizy (domyślnie `.data/puppeteer-eremiza`)
- `EREMIZA_HEADLESS` - `false` / `0` — widoczne okno (jak `MESSENGER_HEADLESS`)
- `GIST_ID` - The ID of the gist
- `GIST_TOKEN` - The token of the gist
- `MAPBOX_TOKEN` - [The access token of Mapbox](https://account.mapbox.com/access-tokens/)
- `FIRE_BRIGADE_COORDINATES` - i.e. 51.2311409,22.4626970. Can be generated [here](https://www.gps-coordinates.net/)
