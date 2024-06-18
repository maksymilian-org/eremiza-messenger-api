The application could be used by request to the server:

- Run `npm start`
- Call http://localhost:3000/send

## GIST Configuration

Create a new empty gist file (`last-alert.json` with empty object) here: https://gist.github.com/ and generate a access token: https://github.com/settings/tokens/new?scopes=gist, then putproper values in `GIST_TOKEN` and `GIST_ID` environment variables.

## Environment variables:

- `MESSENGER_EMAIL` - Email address of the Messenger user
- `MESSENGER_PASSWORD` - Password of the Messenger user
- `MESSENGER_CONVERSATION_URL` - URL of the conversation to send messages
