// ============================================
// BRAINBATTLE MULTIPLAYER SERVER
// ============================================
// This is the brain of your online game.
// It handles:
//   1. Players connecting via WebSocket
//   2. Matchmaking queue (grouping 5 players)
//   3. Game rooms (topic selection, questions, scoring)
//   4. Broadcasting game state to all players in a room
//
// HOW IT WORKS:
// - A player's browser opens a WebSocket connection to this server
// - The player sends JSON messages like { type: 'join_queue', name: 'Alex' }
// - The server processes the message and sends back responses
// - When 5 players are queued, they get put into a "room" together
// - The server controls the game flow and tells all players what's happening

const { WebSocketServer } = require('ws');
const http = require('http');

// ── CONFIG ──
const PORT = process.env.PORT || 3000;
const PLAYERS_PER_ROOM = 5;
const TIMER_SECS = 10;
const TOPIC_TIMER_SECS = 5;

// ── QUESTIONS DATABASE ──
// Same questions as your frontend, but now the server owns them.
// This prevents cheating — players never see the correct answer
// until the server tells them.
const QUESTIONS_DB = require('./questions.js');

const TOPICS = [
  {id:'history',name:'History',icon:'🏛️',desc:'Events, figures, civilizations',color:'251,191,36'},
  {id:'geography',name:'Geography',icon:'🗺️',desc:'Countries, capitals, landmarks',color:'52,211,153'},
  {id:'movies',name:'Movies & TV',icon:'🎬',desc:'Cinema, streaming, pop culture',color:'251,113,133'},
  {id:'sports',name:'Sports',icon:'⚽',desc:'Teams, athletes, records',color:'34,211,238'},
  {id:'music',name:'Music',icon:'🎵',desc:'Artists, albums, genres',color:'192,132,252'},
  {id:'tech',name:'Technology',icon:'💻',desc:'Gadgets, software, internet',color:'96,165,250'},
  {id:'space',name:'Space',icon:'🚀',desc:'Planets, stars, missions',color:'199,210,254'},
  {id:'anime',name:'Anime & Manga',icon:'🎌',desc:'Shonen, heroes, studios',color:'244,114,182'},
  {id:'games',name:'Video Games',icon:'🎮',desc:'Consoles, titles, characters',color:'163,230,53'},
  {id:'mythology',name:'Mythology',icon:'⚡',desc:'Gods, legends, folklore',color:'253,164,75'},
  {id:'harrypotter',name:'Harry Potter',icon:'🧙',desc:'Wizards, spells, Hogwarts',color:'139,92,246'},
  {id:'starwars',name:'Star Wars',icon:'🌌',desc:'Jedi, Sith, galaxy far away',color:'103,232,249'},
  {id:'lotr',name:'Lord of the Rings',icon:'💍',desc:'Middle-earth, hobbits, rings',color:'217,180,120'},
  {id:'got',name:'Game of Thrones',icon:'🐉',desc:'Westeros, houses, dragons',color:'239,68,68'},
  {id:'breakingbad',name:'Breaking Bad',icon:'🧪',desc:'Heisenberg, meth, Albuquerque',color:'74,222,128'},
  {id:'pokemon',name:'Pokémon',icon:'⚡',desc:'Trainers, battles, Gotta catch em all',color:'250,204,21'},
  {id:'markets',name:'Markets',icon:'📈',desc:'Stocks, crypto, scams, Wall Street',color:'34,197,94'},
  {id:'disney',name:'Disney & Pixar',icon:'🏰',desc:'Princesses, Pixar, animated classics',color:'147,51,234'}
];

// ── STATE ──
// These are the "live" data structures the server keeps in memory.
// When the server restarts, these reset (we'll add a database later for persistence).

const queue = [];          // Players waiting for a match
const rooms = new Map();   // Active game rooms: roomId -> Room object
const playerMap = new Map(); // WebSocket -> player info (for quick lookup)

let nextRoomId = 1;

// ── HELPER FUNCTIONS ──

function generateId() {
  return 'room_' + (nextRoomId++);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Send a JSON message to one player (skip bots)
function send(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// Send a JSON message to ALL players in a room
function broadcast(room, data) {
  room.players.forEach(p => send(p.ws, data));
}

// Send a message to all players in a room EXCEPT one
function broadcastExcept(room, exceptWs, data) {
  room.players.forEach(p => {
    if (p.ws !== exceptWs) send(p.ws, data);
  });
}

// ── ROOM / GAME LOGIC ──

function createRoom(players) {
  const roomId = generateId();
  const room = {
    id: roomId,
    players: players.map((p, i) => {
      if (p.isBot && p.botData) {
        // Bot player
        return { ...p.botData, index: i };
      }
      return {
        ws: p.ws,
        name: p.name,
        index: i,
        score: 0,
        roundScore: 0,
        roundCorrect: 0,
        roundTime: 0,
        roundTotalTime: 0,
        eliminated: false,
        topicPick: null,
        answered: false,
        answerTime: 0,
      };
    }),
    round: 1,
    currentQ: 0,
    topics: [],
    questions: [],
    questionStartTime: null,
    topicTimer: null,
    questionTimer: null,
    botEmoteInterval: null,
    phase: 'topic_selection',
  };

  rooms.set(roomId, room);

  // Tell each REAL player about the room and all other players
  room.players.forEach(p => {
    if (p.ws) {
      playerMap.set(p.ws, { roomId, playerIndex: p.index });
      send(p.ws, {
        type: 'match_found',
        roomId,
        yourIndex: p.index,
        players: room.players.map(pl => ({ name: pl.name, index: pl.index }))
      });
    }
  });

  // Start topic selection after a short delay
  setTimeout(() => startTopicSelection(room), 1000);

  console.log(`Room ${roomId} created with ${room.players.filter(p=>!p.isBot).length} real + ${room.players.filter(p=>p.isBot).length} bot players`);
  return room;
}

function startTopicSelection(room) {
  room.phase = 'topic_selection';

  // Give each player 3 random topic options
  room.players.forEach(p => {
    if (p.eliminated) return;
    const options = shuffle(TOPICS).slice(0, 3);
    p.topicOptions = options;
    p.topicPick = null;
    send(p.ws, {
      type: 'topic_selection',
      round: room.round,
      options: options.map(t => ({ id: t.id, name: t.name, icon: t.icon, desc: t.desc, color: t.color }))
    });
  });

  // Broadcast to everyone that topic selection started
  broadcast(room, { type: 'topic_phase_start', round: room.round });

  // Trigger bot topic picks
  room.players.filter(p => p.isBot && !p.eliminated).forEach(p => botPickTopic(room, p));

  // Start 10-second timer — auto-pick for anyone who hasn't chosen
  room.topicTimer = setTimeout(() => {
    const active = room.players.filter(p => !p.eliminated);
    active.forEach(p => {
      if (!p.topicPick && p.topicOptions) {
        p.topicPick = p.topicOptions[Math.floor(Math.random() * p.topicOptions.length)];
        broadcast(room, {
          type: 'player_picked_topic',
          playerIndex: p.index,
          topic: { id: p.topicPick.id, name: p.topicPick.name, icon: p.topicPick.icon }
        });
      }
    });
    finishTopicSelection(room);
  }, TOPIC_TIMER_SECS * 1000);
}

function handleTopicPick(room, playerIndex, topicId) {
  const player = room.players[playerIndex];
  if (!player || player.eliminated || player.topicPick) return;

  const topic = player.topicOptions?.find(t => t.id === topicId);
  if (!topic) return;

  player.topicPick = topic;

  // Tell everyone this player picked
  broadcast(room, {
    type: 'player_picked_topic',
    playerIndex: player.index,
    topic: { id: topic.id, name: topic.name, icon: topic.icon }
  });

  // Check if all active players have picked
  const active = room.players.filter(p => !p.eliminated);
  if (active.every(p => p.topicPick)) {
    clearTimeout(room.topicTimer);
    setTimeout(() => finishTopicSelection(room), 1000);
  }
}

function finishTopicSelection(room) {
  // Collect unique topics from player picks, fill to 5 if needed
  const picked = [];
  const seen = new Set();
  room.players.filter(p => !p.eliminated && p.topicPick).forEach(p => {
    if (!seen.has(p.topicPick.id)) {
      seen.add(p.topicPick.id);
      picked.push(p.topicPick);
    }
  });
  while (picked.length < 5) {
    const t = TOPICS.find(t => !seen.has(t.id));
    if (t) { seen.add(t.id); picked.push(t); }
    else break;
  }
  room.topics = picked.slice(0, 5);

  broadcast(room, {
    type: 'topics_locked',
    topics: room.topics.map(t => ({ id: t.id, name: t.name, icon: t.icon, color: t.color }))
  });

  // Build questions and start the round
  setTimeout(() => startRound(room), 1200);
}

function startRound(room) {
  room.phase = 'playing';
  room.currentQ = 0;

  // Reset round stats for active players
  room.players.filter(p => !p.eliminated).forEach(p => {
    p.roundScore = 0;
    p.roundCorrect = 0;
    p.roundTime = 0;
    p.roundTotalTime = 0;
    p.answered = false;
  });

  // Build 5 questions (one per topic), avoiding repeats from earlier rounds
  if (!room.usedQuestions) room.usedQuestions = {};
  room.questions = room.topics.map(topic => {
    const pool = QUESTIONS_DB[topic.id] || [];
    if (!room.usedQuestions[topic.id]) room.usedQuestions[topic.id] = [];
    const available = pool.filter((_, i) => !room.usedQuestions[topic.id].includes(i));
    const src = available.length ? available : pool;
    const q = src[Math.floor(Math.random() * src.length)];
    room.usedQuestions[topic.id].push(pool.indexOf(q));
    return { ...q, topicId: topic.id, topicName: topic.name, topicIcon: topic.icon };
  });

  broadcast(room, { type: 'round_start', round: room.round });
  setTimeout(() => sendQuestion(room), 500);
}

function sendQuestion(room) {
  const q = room.questions[room.currentQ];
  if (!q) return;

  room.players.filter(p => !p.eliminated).forEach(p => { p.answered = false; });
  room.acceptingAnswers = false; // Block answers during grace period

  // Send question to all players — but WITHOUT the correct answer!
  broadcast(room, {
    type: 'question',
    questionIndex: room.currentQ,
    topic: q.topicName,
    topicIcon: q.topicIcon,
    topicId: q.topicId,
    text: q.q,
    options: q.opts,
    // NOTE: we do NOT send q.a (correct answer) — that stays on the server
  });

  // 1-second grace period — let everyone read the question before timer starts
  setTimeout(() => {
    room.questionStartTime = Date.now();
    room.acceptingAnswers = true;

    // Tell clients to start their timers
    broadcast(room, { type: 'timer_start' });

    // Start question timer
    room.questionTimer = setTimeout(() => {
      // Time's up — score anyone who hasn't answered as wrong
      room.players.filter(p => !p.eliminated && !p.answered).forEach(p => {
        p.answered = true;
      });
      revealAnswer(room);
    }, TIMER_SECS * 1000);

    // Trigger bot answers
    room.players.filter(p => p.isBot && !p.eliminated).forEach(p => botAnswerQuestion(room, p));
  }, 1000);

  // Start bot emotes if not already running
  if (!room.botEmoteInterval) startBotEmotes(room);
}

function handleAnswer(room, playerIndex, answerIndex) {
  const player = room.players[playerIndex];
  if (!player || player.eliminated || player.answered) return;
  if (room.phase !== 'playing') return;
  if (!room.acceptingAnswers) return; // Grace period still active

  player.answered = true;
  const q = room.questions[room.currentQ];
  const timeTaken = (Date.now() - room.questionStartTime) / 1000;
  const correct = answerIndex === q.a;

  // Calculate points — tier system: 0-2s=100, 2-4s=80-95, 4-7s=40-75, 7-10s=10-35
  let pts = 0;
  if (correct) {
    if (timeTaken <= 2) pts = 100;
    else if (timeTaken <= 4) pts = Math.round(95 - ((timeTaken - 2) / 2) * 15); // 95 down to 80
    else if (timeTaken <= 7) pts = Math.round(75 - ((timeTaken - 4) / 3) * 35); // 75 down to 40
    else pts = Math.round(35 - ((timeTaken - 7) / 3) * 25); // 35 down to 10
    pts = Math.max(10, pts);
  }

  player.roundScore += pts;
  player.roundTime += timeTaken;
  if (correct) {
    player.roundCorrect++;
    player.roundTotalTime += timeTaken;
  }

  // Tell this player their result
  send(player.ws, {
    type: 'answer_result',
    correct,
    points: pts,
    timeTaken: Math.round(timeTaken * 10) / 10,
    correctIndex: q.a,
  });

  // Tell everyone that this player answered (but not what they picked)
  broadcast(room, {
    type: 'player_answered',
    playerIndex: player.index,
    // We broadcast updated scores so the race board updates
    scores: getScoreboard(room),
  });

  // Check if all active players have answered
  const active = room.players.filter(p => !p.eliminated);
  if (active.every(p => p.answered)) {
    clearTimeout(room.questionTimer);
    setTimeout(() => revealAnswer(room), 300);
  }
}

function revealAnswer(room) {
  const q = room.questions[room.currentQ];

  // Tell everyone the correct answer
  broadcast(room, {
    type: 'answer_reveal',
    correctIndex: q.a,
    scores: getScoreboard(room),
  });

  // Next question or end round
  setTimeout(() => {
    room.currentQ++;
    if (room.currentQ >= 5) {
      endRound(room);
    } else {
      sendQuestion(room);
    }
  }, 1200);
}

function getScoreboard(room) {
  return room.players
    .filter(p => !p.eliminated && !p.disconnected)
    .map(p => ({
      index: p.index,
      name: p.name,
      roundScore: p.roundScore,
      answered: p.answered,
    }))
    .sort((a, b) => b.roundScore - a.roundScore);
}

function endRound(room) {
  room.phase = 'round_end';

  const active = room.players.filter(p => !p.eliminated);
  const sorted = [...active].sort((a, b) => {
    if (b.roundScore !== a.roundScore) return b.roundScore - a.roundScore;
    return a.roundTime - b.roundTime;
  });

  const isFinale = room.round === 3;
  let eliminatedPlayer = null;

  if (!isFinale) {
    eliminatedPlayer = sorted[sorted.length - 1];
    eliminatedPlayer.eliminated = true;
  }

  // Add round scores to total
  active.forEach(p => { p.score += p.roundScore; });

  // Send round results to everyone
  broadcast(room, {
    type: 'round_end',
    round: room.round,
    isFinale,
    results: sorted.map((p, i) => ({
      index: p.index,
      name: p.name,
      roundScore: p.roundScore,
      totalScore: p.score,
      rank: i + 1,
      eliminated: !isFinale && p === eliminatedPlayer,
    })),
    eliminatedIndex: eliminatedPlayer ? eliminatedPlayer.index : null,
  });

  if (isFinale) {
    // Check for tie in finale
    if (sorted.length >= 2 && sorted[0].roundScore === sorted[1].roundScore) {
      setTimeout(() => startSuddenDeath(room, sorted[0], sorted[1]), 3000);
    } else {
      setTimeout(() => endGame(room, sorted), 3000);
    }
  } else {
    // Next round after delay — topics already picked, go straight to playing
    setTimeout(() => {
      room.round++;
      startRound(room);
    }, 5000);
  }
}

function startSuddenDeath(room, p1, p2) {
  room.phase = 'sudden_death';

  // Pick a random question
  const allTopicIds = Object.keys(QUESTIONS_DB);
  const tid = allTopicIds[Math.floor(Math.random() * allTopicIds.length)];
  const pool = QUESTIONS_DB[tid];
  const q = pool[Math.floor(Math.random() * pool.length)];
  room.sdQuestion = q;
  room.sdPlayers = [p1, p2];
  room.sdAnswers = {};
  room.questionStartTime = Date.now();

  broadcast(room, {
    type: 'sudden_death',
    player1: { index: p1.index, name: p1.name },
    player2: { index: p2.index, name: p2.name },
    text: q.q,
    options: q.opts,
  });

  room.questionTimer = setTimeout(() => {
    // Time's up — whoever answered correctly first wins, or p1 by default
    resolveSuddenDeath(room);
  }, TIMER_SECS * 1000);

  // Trigger bot answers in sudden death
  [p1, p2].filter(p => p.isBot).forEach(p => botAnswerSuddenDeath(room, p));
}

function handleSuddenDeathAnswer(room, playerIndex, answerIndex) {
  if (room.sdAnswers[playerIndex] !== undefined) return;

  const timeTaken = (Date.now() - room.questionStartTime) / 1000;
  const correct = answerIndex === room.sdQuestion.a;
  room.sdAnswers[playerIndex] = { correct, time: timeTaken, answer: answerIndex };

  send(room.players[playerIndex].ws, {
    type: 'sd_answer_result',
    correct,
    correctIndex: room.sdQuestion.a,
  });

  // If this player got it right, they win immediately
  if (correct) {
    clearTimeout(room.questionTimer);
    setTimeout(() => resolveSuddenDeath(room), 1000);
    return;
  }

  // If both have answered, resolve
  const both = room.sdPlayers.every(p => room.sdAnswers[p.index] !== undefined);
  if (both) {
    clearTimeout(room.questionTimer);
    setTimeout(() => resolveSuddenDeath(room), 1000);
  }
}

function resolveSuddenDeath(room) {
  const [p1, p2] = room.sdPlayers;
  const a1 = room.sdAnswers[p1.index];
  const a2 = room.sdAnswers[p2.index];

  let winner, loser;

  // Determine winner: correct answer wins; if both correct, faster wins; if neither, faster wins
  if (a1?.correct && !a2?.correct) { winner = p1; loser = p2; }
  else if (a2?.correct && !a1?.correct) { winner = p2; loser = p1; }
  else if (a1?.correct && a2?.correct) { winner = a1.time <= a2.time ? p1 : p2; loser = winner === p1 ? p2 : p1; }
  else { winner = p1; loser = p2; } // fallback

  const active = room.players.filter(p => !p.eliminated);
  const sorted = [winner, loser, ...active.filter(p => p !== winner && p !== loser)];

  broadcast(room, {
    type: 'sudden_death_result',
    winnerIndex: winner.index,
    loserIndex: loser.index,
    correctIndex: room.sdQuestion.a,
  });

  setTimeout(() => endGame(room, sorted), 2000);
}

function endGame(room, sorted) {
  room.phase = 'finished';
  clearInterval(room.botEmoteInterval);

  // Include eliminated players for full final standings
  const eliminated = room.players.filter(p => p.eliminated).reverse();
  const fullStandings = [...sorted.filter(p => !p.eliminated), ...eliminated];

  broadcast(room, {
    type: 'game_over',
    standings: fullStandings.map((p, i) => ({
      index: p.index,
      name: p.name,
      totalScore: p.score,
      place: i + 1,
    })),
    winnerIndex: sorted[0].index,
    winnerName: sorted[0].name,
  });

  // Clean up room after a delay
  setTimeout(() => {
    room.players.forEach(p => playerMap.delete(p.ws));
    rooms.delete(room.id);
    console.log(`Room ${room.id} cleaned up`);
  }, 10000);
}

// ── EMOTES ──
function handleEmote(room, playerIndex, emoji) {
  // Broadcast to all other players in the room
  broadcastExcept(room, room.players[playerIndex]?.ws, {
    type: 'emote',
    playerIndex,
    emoji,
  });
}

// ── BOT SYSTEM ──
const BOT_NAMES = ['Alex','Jordan','Sam','Riley','Morgan','Casey','Quinn','Avery','Blake','Drew','Skyler','Sage','Rowan','Harper','Reese','Dakota','Finley','Emery','Hayden','Logan'];
const BOT_EMOTES = ['😂','😱','🤯','👏','💀','😤','🥶','👀'];

function createBot(name) {
  return {
    ws: null,
    name: name,
    isBot: true,
    score: 0,
    roundScore: 0,
    roundCorrect: 0,
    roundTime: 0,
    roundTotalTime: 0,
    eliminated: false,
    topicPick: null,
    answered: false,
    answerTime: 0,
    botAccuracy: 0.55 + Math.random() * 0.15, // 55-70% per bot
  };
}

function getBotNames(count) {
  const shuffled = shuffle([...BOT_NAMES]);
  // Avoid names already in queue
  const taken = new Set(queue.map(p => p.name));
  return shuffled.filter(n => !taken.has(n)).slice(0, count);
}

// Bot auto-pick topic after random delay
function botPickTopic(room, player) {
  if (!player.isBot || player.eliminated || player.topicPick) return;
  const delay = 1500 + Math.random() * 4000;
  setTimeout(() => {
    if (player.topicPick || room.phase !== 'topic_selection') return;
    const topic = player.topicOptions[Math.floor(Math.random() * player.topicOptions.length)];
    handleTopicPick(room, player.index, topic.id);
  }, delay);
}

// Bot auto-answer question after random delay
function botAnswerQuestion(room, player) {
  if (!player.isBot || player.eliminated || player.answered) return;
  const delay = 2000 + Math.random() * 5000; // 2-7 seconds
  const timeout = setTimeout(() => {
    if (player.answered || room.phase !== 'playing') return;
    const q = room.questions[room.currentQ];
    if (!q) return;
    const correct = Math.random() < player.botAccuracy;
    const answerIndex = correct ? q.a : [0,1,2,3].filter(i => i !== q.a)[Math.floor(Math.random() * 3)];
    handleAnswer(room, player.index, answerIndex);
  }, delay);
  // Store timeout so we can clear on disconnect
  player._botAnswerTimeout = timeout;
}

// Bot auto-answer sudden death
function botAnswerSuddenDeath(room, player) {
  if (!player.isBot) return;
  const delay = 2000 + Math.random() * 5000;
  setTimeout(() => {
    if (room.sdAnswers[player.index] !== undefined || room.phase !== 'sudden_death') return;
    const correct = Math.random() < 0.5;
    const q = room.sdQuestion;
    const answerIndex = correct ? q.a : [0,1,2,3].filter(i => i !== q.a)[Math.floor(Math.random() * 3)];
    handleSuddenDeathAnswer(room, player.index, answerIndex);
  }, delay);
}

// Bot emotes during gameplay
function startBotEmotes(room) {
  clearInterval(room.botEmoteInterval);
  room.botEmoteInterval = setInterval(() => {
    if (room.phase !== 'playing') { clearInterval(room.botEmoteInterval); return; }
    const bots = room.players.filter(p => p.isBot && !p.eliminated);
    if (!bots.length) { clearInterval(room.botEmoteInterval); return; }
    // ~20% chance every 4 seconds for a random bot
    if (Math.random() < 0.20) {
      const bot = bots[Math.floor(Math.random() * bots.length)];
      const emoji = BOT_EMOTES[Math.floor(Math.random() * BOT_EMOTES.length)];
      broadcast(room, { type: 'emote', playerIndex: bot.index, emoji });
    }
  }, 4000);
}

// Queue backfill timer — checks every 5 seconds
let queueBackfillTimer = null;
function startQueueBackfill() {
  if (queueBackfillTimer) return;
  queueBackfillTimer = setInterval(() => {
    if (queue.length === 0) return;
    // Check if any player has been waiting 30+ seconds
    const now = Date.now();
    const waitingLong = queue.some(p => p.joinedAt && (now - p.joinedAt) >= 12000);
    if (waitingLong && queue.length < PLAYERS_PER_ROOM) {
      const botsNeeded = PLAYERS_PER_ROOM - queue.length;
      const botNames = getBotNames(botsNeeded);
      botNames.forEach(name => {
        const bot = createBot(name);
        queue.push({ ws: null, name: bot.name, isBot: true, botData: bot });
        console.log(`Bot ${name} added to queue (${queue.length}/${PLAYERS_PER_ROOM})`);
      });
      // Notify real players
      queue.filter(p => p.ws).forEach(p => send(p.ws, {
        type: 'queue_update',
        count: queue.length,
        needed: PLAYERS_PER_ROOM,
      }));
      // Check if we now have enough
      if (queue.length >= PLAYERS_PER_ROOM) {
        const roomPlayers = queue.splice(0, PLAYERS_PER_ROOM);
        createRoom(roomPlayers);
      }
    }
  }, 5000);
}
startQueueBackfill();

// ── MATCHMAKING QUEUE ──

function addToQueue(ws, name) {
  // Remove if already in queue
  const existing = queue.findIndex(p => p.ws === ws);
  if (existing >= 0) queue.splice(existing, 1);

  queue.push({ ws, name, joinedAt: Date.now() });
  console.log(`${name} joined queue (${queue.length}/${PLAYERS_PER_ROOM})`);

  // Notify everyone in queue about the current count
  queue.forEach(p => send(p.ws, {
    type: 'queue_update',
    count: queue.length,
    needed: PLAYERS_PER_ROOM,
  }));

  // Check if we have enough players
  if (queue.length >= PLAYERS_PER_ROOM) {
    const roomPlayers = queue.splice(0, PLAYERS_PER_ROOM);
    createRoom(roomPlayers);
  }
}

function removeFromQueue(ws) {
  const idx = queue.findIndex(p => p.ws === ws);
  if (idx >= 0) {
    console.log(`${queue[idx].name} left queue`);
    queue.splice(idx, 1);
    // Update remaining queue members
    queue.forEach(p => send(p.ws, {
      type: 'queue_update',
      count: queue.length,
      needed: PLAYERS_PER_ROOM,
    }));
  }
}

// ── WEBSOCKET SERVER ──

const server = http.createServer((req, res) => {
  // Simple health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      queue: queue.length,
      rooms: rooms.size,
      players: playerMap.size,
    }));
    return;
  }

  // Serve a simple status page
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <h1>Mindbrawl Server</h1>
    <p>Queue: ${queue.length} players</p>
    <p>Active rooms: ${rooms.size}</p>
    <p>Connected players: ${playerMap.size}</p>
  `);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('New connection');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join_queue':
        // Player wants to find a match
        if (!msg.name || msg.name.length > 16) return;
        addToQueue(ws, msg.name.trim());
        break;

      case 'leave_queue':
        removeFromQueue(ws);
        break;

      case 'pick_topic':
        // Player picked a topic during selection phase
        const info1 = playerMap.get(ws);
        if (!info1) return;
        const room1 = rooms.get(info1.roomId);
        if (!room1) return;
        handleTopicPick(room1, info1.playerIndex, msg.topicId);
        break;

      case 'answer':
        // Player answered a question
        const info2 = playerMap.get(ws);
        if (!info2) return;
        const room2 = rooms.get(info2.roomId);
        if (!room2) return;
        if (room2.phase === 'sudden_death') {
          handleSuddenDeathAnswer(room2, info2.playerIndex, msg.answerIndex);
        } else {
          handleAnswer(room2, info2.playerIndex, msg.answerIndex);
        }
        break;

      case 'emote':
        // Player sent an emote
        const info3 = playerMap.get(ws);
        if (!info3) return;
        const room3 = rooms.get(info3.roomId);
        if (!room3) return;
        handleEmote(room3, info3.playerIndex, msg.emoji);
        break;
    }
  });

  ws.on('close', () => {
    console.log('Connection closed');
    removeFromQueue(ws);

    // If player was in a room, handle disconnect
    const info = playerMap.get(ws);
    if (info) {
      const room = rooms.get(info.roomId);
      if (room) {
        const player = room.players[info.playerIndex];
        if (player && !player.eliminated) {
          player.disconnected = true;
          player.eliminated = true;
          player.answered = true; // Don't wait for their answer
          
          broadcast(room, {
            type: 'player_disconnected',
            playerIndex: info.playerIndex,
            name: player.name,
          });

          console.log(`${player.name} disconnected from room ${room.id}`);

          // Check if enough players remain
          const remaining = room.players.filter(p => !p.eliminated);
          
          if (remaining.length < 2) {
            // Not enough players — end the game
            clearTimeout(room.questionTimer);
            clearTimeout(room.topicTimer);
            if (remaining.length === 1) {
              // Last player standing wins
              const winner = remaining[0];
              broadcast(room, {
                type: 'game_over',
                standings: room.players.map((p, i) => ({
                  index: p.index, name: p.name,
                  totalScore: p.score || 0,
                  place: p === winner ? 1 : p.eliminated ? (room.players.filter(x => x.eliminated).indexOf(p) + 2) : 2,
                })).sort((a, b) => a.place - b.place),
                winnerIndex: winner.index,
                winnerName: winner.name,
              });
            }
            // Clean up room
            setTimeout(() => {
              room.players.forEach(p => playerMap.delete(p.ws));
              rooms.delete(room.id);
            }, 5000);
            return;
          }

          // If in playing phase, check if all remaining players have answered
          if (room.phase === 'playing') {
            const active = room.players.filter(p => !p.eliminated);
            if (active.every(p => p.answered)) {
              clearTimeout(room.questionTimer);
              setTimeout(() => revealAnswer(room), 300);
            }
          }

          // If in topic_selection phase, check if all remaining players have picked
          if (room.phase === 'topic_selection') {
            const active = room.players.filter(p => !p.eliminated);
            if (active.every(p => p.topicPick)) {
              clearTimeout(room.topicTimer);
              setTimeout(() => finishTopicSelection(room), 500);
            }
          }

          // If in sudden_death phase, resolve it
          if (room.phase === 'sudden_death' && room.sdPlayers) {
            const sdOpponent = room.sdPlayers.find(p => p !== player);
            if (sdOpponent) {
              clearTimeout(room.questionTimer);
              setTimeout(() => {
                const sorted = [sdOpponent, player];
                const allActive = room.players.filter(p => !p.disconnected);
                endGame(room, [...sorted, ...allActive.filter(p => p !== sdOpponent && p !== player)]);
              }, 1000);
            }
          }
        }
      }
      playerMap.delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mindbrawl server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
