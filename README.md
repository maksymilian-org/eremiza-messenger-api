The application could be used by request to the server:

- Run `npm start`
- Call http://localhost:3000

## GIST Configuration

[Create a new empty gist file](https://gist.github.com/) (`last-alert.json` with empty object) and [generate a access token](https://github.com/settings/tokens/new?scopes=gist), then put proper values in `GIST_TOKEN` and `GIST_ID` environment variables.

## Environment variables:

- `MESSENGER_EMAIL` - Email address of the Messenger user
- `MESSENGER_PASSWORD` - Password of the Messenger user
- `MESSENGER_CONVERSATION_URL` - URL of the conversation to send messages
- `EREMIZA_LOGIN` - Login to the e-Remiza account which has permissions to read all alerts data
- `EREMIZA_PASSWORD` - Password to the e-Remiza account
- `GIST_ID` - The ID of the gist
- `GIST_TOKEN` - The token of the gist
- `MAPBOX_TOKEN` - [The access token of Mapbox](https://account.mapbox.com/access-tokens/)
- `FIRE_BRIGADE_COORDINATES` - i.e. 51.2311409,22.4626970. Can be generated [here](https://www.gps-coordinates.net/)
