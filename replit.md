# TOMI WebSocket Chat

## Running the app on Replit

1. Install dependencies with `npm install`.
2. Start the configured `Start application` workflow, which runs `PORT=5000 npm start`.
3. Open the Replit preview at `/` to create or join a room.

The app uses Express and Socket.IO. Chat history and uploaded media are kept in memory for the running server and are also archived under `~/Desktop/Admin_Chat_Archive` in the server environment.