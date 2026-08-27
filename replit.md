# TOMI WebSocket Chat

## Running the app on Replit

1. Install dependencies with `npm install`.
2. Start the configured `Start application` workflow, which runs `PORT=5000 npm start`.
3. Open the Replit preview at `/` to create or join a room.

The app uses Express and Socket.IO. Chat history and uploaded media are kept in memory for the running server and are also archived under `~/Desktop/Admin_Chat_Archive` in the server environment.

## Telegram logging

Set these values in Replit Secrets (never commit them to the repository):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

When both secrets are present, every text and media event is forwarded through the Telegram Bot API before it is broadcast to the room. Forwarding is serialized per room, and a clear-room request waits for earlier Telegram copies to finish.