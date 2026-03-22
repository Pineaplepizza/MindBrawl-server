# Mindbrawl Server — Step by Step Guide

## What is this?

This is the backend server for Mindbrawl. It handles:
- **Matchmaking** — grouping 5 players together
- **Game logic** — sending questions, validating answers, scoring
- **Real-time sync** — keeping all players' screens in sync via WebSocket

## Prerequisites

You need **Node.js** installed on your computer.

### Installing Node.js (if you don't have it)

1. Go to https://nodejs.org
2. Download the **LTS** version (the green button)
3. Run the installer, click Next through everything
4. To verify it worked, open your terminal/command prompt and type:
   ```
   node --version
   ```
   You should see something like `v20.x.x`

## Running the server locally

1. **Open your terminal** (Command Prompt on Windows, Terminal on Mac)

2. **Navigate to this folder:**
   ```
   cd path/to/mindbrawl-server
   ```

3. **Install dependencies** (only needed once):
   ```
   npm install
   ```

4. **Start the server:**
   ```
   npm start
   ```

5. You should see:
   ```
   Mindbrawl server running on port 3000
   ```

6. Open http://localhost:3000 in your browser — you should see a status page.

## Testing with multiple players

To test locally with multiple "players":
1. Start the server
2. Open 5 browser tabs with your game HTML
3. Enter different nicknames and press Play in each one
4. They'll all connect to localhost:3000 and matchmake together

## Deploying to Railway (recommended)

Railway gives you a free server on the internet so real people can play.

### First time setup:

1. Go to https://railway.app and sign up (GitHub login works)
2. Click **"New Project"** → **"Deploy from GitHub Repo"**
3. If your code isn't on GitHub yet:
   - Create a GitHub account at https://github.com
   - Create a new repository
   - Upload the `mindbrawl-server` folder contents
4. Railway will auto-detect it's a Node.js project
5. Click **Deploy** — it'll install dependencies and start your server
6. Railway gives you a URL like `mindbrawl-server-production-xxxx.up.railway.app`
7. That's your server URL — put it in your game's frontend code

### Environment:

Railway automatically sets the PORT environment variable. The server already reads it:
```js
const PORT = process.env.PORT || 3000;
```

## File structure

```
mindbrawl-server/
  package.json    — Project config and dependencies
  server.js       — The main server (all game logic)
  questions.js    — Questions database
  README.md       — This file
```

## How messages flow

```
Player Browser                    Server
     |                              |
     |-- join_queue {name} -------->|
     |                              |--- adds to queue
     |<-- queue_update {count} -----|
     |                              |--- when 5 players queued:
     |<-- match_found {players} ----|
     |                              |
     |<-- topic_selection {opts} ---|
     |-- pick_topic {topicId} ----->|
     |<-- player_picked_topic ------|
     |<-- topics_locked ------------|
     |                              |
     |<-- question {text, opts} ----|
     |-- answer {answerIndex} ----->|
     |<-- answer_result {correct} --|
     |<-- answer_reveal ------------|
     |                              |
     |<-- round_end {results} ------|
     |      ... repeat 3 rounds ... |
     |<-- game_over {standings} ----|
```

## Next steps

Once the server is deployed, you need to update the game frontend to:
1. Connect to the server via WebSocket instead of using bots
2. Send/receive messages instead of simulating bot behavior
3. The UI stays exactly the same — only the data source changes

Claude can help you with this part when you're ready!
