const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);


app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

const sessions = new Map();

app.get('/', (req, res) => {
  const list = Array.from(sessions.values()).map(s => ({
    id: s.id,
    masterName: s.masterName,
    playersCount: Object.keys(s.players).length,
    status: s.status
  }));
  res.render('index', { sessions: list });
});

app.post('/create', (req, res) => {
  // create session page prefilled
  const { name } = req.body;
  const sessionId = uuidv4().slice(0, 8);
  res.redirect(`/session/${sessionId}?name=${encodeURIComponent(name || 'Host')}&create=1`);
});

app.get('/session/:id', (req, res) => {
  const id = req.params.id;
  const name = (req.query.name || '').trim() || 'Player';
  const create = !!req.query.create;
  // If session exists, ensure join rules
  let session = sessions.get(id);
  const playersCount = session ? Object.keys(session.players).length : 0;
  res.render('session', { sessionId: id, name, create, sessionExists: !!session, playersCount });
});

// for server side
app.get('/session/:id/info', (req, res) => {
  const id = req.params.id;
  const s = sessions.get(id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    id: s.id,
    masterName: s.masterName,
    playersCount: Object.keys(s.players).length,
    status: s.status
  });
});

app.get('/api/check-session/:id', (req, res) => {
  const id = req.params.id;

  if (sessions.has(id)) {
    return res.json({ exists: true });
  }

  res.json({ exists: false });
});


// Socket.IO realtime logic
io.on('connection', (socket) => {
  
  // Send sessions list to client
  socket.on('get-sessions-list', () => {
    const list = Array.from(sessions.values()).map(s => ({
      id: s.id,
      masterName: s.masterName,
      playersCount: Object.keys(s.players).length,
      status: s.status
    }));
    socket.emit('sessions-list-update', list);
  });

  socket.on('join_session', ({ sessionId, name }, cb) => {
    name = (name || 'Player').toString().trim().slice(0, 30);
    if (!sessionId || !name) return cb && cb({ error: 'Invalid session or name' });

    let session = sessions.get(sessionId);
    if (!session) {
      // If socket requested to create session (first connection becomes master)
      session = {
        id: sessionId,
        masterSocketId: socket.id,
        masterName: name,
        players: {},
        status: 'waiting',
        question: null,
        answer: null,
        timerHandle: null,
        timeLeft: 0,
        createdAt: new Date()
      };
      sessions.set(sessionId, session);
      socket.join(sessionId);
      socket.sessionId = sessionId;
      socket.playerName = name;

      session.players[socket.id] = { socketId: socket.id, name, score: 0, attemptsLeft: 3 };
      socket.emit('joined', { sessionId, you: { socketId: socket.id, name, score: 0 }, master: true });
      broadcastGameState(sessionId);
      broadcastSessionsList();
      return cb && cb({ ok: true, role: 'master' });
    }

    // existing session: can't join if in-progress
    if (session.status === 'in-progress') {
      return cb && cb({ error: 'Game is already in progress. You cannot join now.' });
    }

    // join as player
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.playerName = name;

    session.players[socket.id] = { socketId: socket.id, name, score: 0, attemptsLeft: 3 };
    socket.emit('joined', { sessionId, you: { socketId: socket.id, name, score: 0 }, master: false, masterName: session.masterName });
    io.to(session.masterSocketId).emit('player_joined', { socketId: socket.id, name });
    broadcastGameState(sessionId);
    broadcastSessionsList();
    cb && cb({ ok: true, role: 'player' });
  });

    socket.on('chat-message', (message) => {
    const sessionId = socket.sessionId; 
    const name = socket.playerName;

    if (!sessionId || !name) return;

    io.to(sessionId).emit('chat-message', {
      name,
      message
    });
  });

  socket.on('create_question', ({ sessionId, question, answer }, cb) => {
    const session = sessions.get(sessionId);
    if (!session) return cb && cb({ error: 'Session not found' });
    if (socket.id !== session.masterSocketId) return cb && cb({ error: 'Only master can set question' });
    question = (question || '').toString().trim().slice(0, 300);
    answer = (answer || '').toString().trim().slice(0, 100);
    if (!question || !answer) return cb && cb({ error: 'Question and answer required' });
    session.question = question;
    session.answer = answer.toLowerCase().trim();
    // reset attempts for all players
    Object.values(session.players).forEach(p => p.attemptsLeft = 3);
    broadcastGameState(sessionId);
    io.to(sessionId).emit('question_created', { question: session.question, masterName: session.masterName });
    cb && cb({ ok: true });
  });

  socket.on('start_game', ({ sessionId, timeLimit }, cb) => {
    const session = sessions.get(sessionId);
    if (!session) return cb && cb({ error: 'Session not found' });
    if (socket.id !== session.masterSocketId) return cb && cb({ error: 'Only master may start' });
    const playersCount = Object.keys(session.players).length;
    if (playersCount <= 2) return cb && cb({ error: 'players must be more than two before game starts' });
    if (!session.question || !session.answer) return cb && cb({ error: 'Please create a question and answer first' });
    session.status = 'in-progress';
    session.timeLeft = Number(timeLimit) || 60;
    // notify players of start and set timer
    io.to(sessionId).emit('game_started', { timeLeft: session.timeLeft, question: session.question });
    // clear any old timer just in case
    if (session.timerHandle) clearInterval(session.timerHandle.intervalId), clearTimeout(session.timerHandle.timeoutId);
    // Every 1s broadcast timeLeft, and schedule end
    const startTs = Date.now();
    const intervalId = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTs) / 1000);
      const left = Math.max(0, session.timeLeft - elapsed);
      io.to(sessionId).emit('tick', { timeLeft: left });
    }, 1000);
    const timeoutId = setTimeout(() => {
      // time expired
      endRoundDueToTime(sessionId);
    }, session.timeLeft * 1000);
    session.timerHandle = { intervalId, timeoutId };
    broadcastGameState(sessionId);
    broadcastSessionsList();
    cb && cb({ ok: true });
  });

  socket.on('submit_guess', ({ sessionId, guess }, cb) => {
    const session = sessions.get(sessionId);
    if (!session) return cb && cb({ error: 'Session not found' });
    if (session.status !== 'in-progress') return cb && cb({ error: 'No game in progress' });
    const player = session.players[socket.id];
    if (!player) return cb && cb({ error: 'You are not part of this session' });
    if (player.attemptsLeft <= 0) return cb && cb({ error: 'No attempts left' });
    if (!guess || typeof guess !== 'string') return cb && cb({ error: 'Invalid guess' });
    guess = guess.trim().toLowerCase().slice(0, 200);

    // Decrement attempt immediately
    player.attemptsLeft -= 1;
    io.to(sessionId).emit('player_attempted', { socketId: socket.id, name: player.name, attemptsLeft: player.attemptsLeft });

    // Check answer
    if (guess === session.answer) {
      // Winner
      player.score += 10;
      // stop timer
      if (session.timerHandle) {
        clearInterval(session.timerHandle.intervalId);
        clearTimeout(session.timerHandle.timeoutId);
        session.timerHandle = null;
      }
      const winner = { socketId: socket.id, name: player.name };
      session.status = 'ended';
      io.to(sessionId).emit('round_ended', { winner, answer: session.answer, message: `${player.name} guessed correctly!` });
      broadcastGameState(sessionId);
      broadcastSessionsList();
      // after a small delay, pick next master and reset question/answer for next round
      setTimeout(() => {
        rotateMasterAndReset(sessionId);
      }, 2000);
      return cb && cb({ ok: true, correct: true });
    } else {
      // wrong guess
      io.to(socket.id).emit('guess_result', { correct: false, attemptsLeft: player.attemptsLeft });
      // check if all players exhausted attempts -> end round no winner (declare no winner)
      const anyCanTry = Object.values(session.players).some(p => p.attemptsLeft > 0);
      if (!anyCanTry) {
        // end round no winner
        if (session.timerHandle) {
          clearInterval(session.timerHandle.intervalId);
          clearTimeout(session.timerHandle.timeoutId);
          session.timerHandle = null;
        }
        session.status = 'ended';
        io.to(sessionId).emit('round_ended', { winner: null, answer: session.answer, message: 'No one guessed the answer' });
        broadcastGameState(sessionId);
        broadcastSessionsList();
        setTimeout(() => {
          rotateMasterAndReset(sessionId);
        }, 2000);
      }
      cb && cb({ ok: true, correct: false });
    }
  });

  socket.on('leave_session', ({ sessionId }, cb) => {
    leaveSession(socket, sessionId);
    cb && cb({ ok: true });
  });

  socket.on('disconnect', () => {
    // remove from any session they are in
    for (const [sessionId, session] of sessions.entries()) {
      if (session.players && session.players[socket.id]) {
        leaveSession(socket, sessionId);
      }
    }
  });

  // Helpers
  function broadcastSessionsList() {
    const list = Array.from(sessions.values()).map(s => ({
      id: s.id,
      masterName: s.masterName,
      playersCount: Object.keys(s.players).length,
      status: s.status
    }));
    io.emit('sessions-list-update', list);
  }

  function broadcastGameState(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    
    const playersArray = Object.values(s.players).map(p => ({
      id: p.socketId,
      name: p.name,
      score: p.score,
      attemptsLeft: p.attemptsLeft,
      isGameMaster: p.socketId === s.masterSocketId
    }));

    io.to(sessionId).emit('game-state', {
      sessionId: s.id,
      players: playersArray,
      gameState: s.status,
      masterSocketId: s.masterSocketId,
      masterName: s.masterName,
      question: s.question,
      timeLeft: s.timeLeft
    });
  }

  function endRoundDueToTime(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.status = 'ended';
    io.to(sessionId).emit('round_ended', { winner: null, answer: s.answer, message: 'Time expired. No winner.' });
    if (s.timerHandle) {
      clearInterval(s.timerHandle.intervalId);
      clearTimeout(s.timerHandle.timeoutId);
      s.timerHandle = null;
    }
    broadcastGameState(sessionId);
    broadcastSessionsList();
    setTimeout(() => {
      rotateMasterAndReset(sessionId);
    }, 2000);
  }

  function rotateMasterAndReset(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    // choose next master as next player in list after current master if available
    const playerIds = Object.keys(s.players);
    if (playerIds.length === 0) {
      // destroy session
      sessions.delete(sessionId);
      broadcastSessionsList();
      return;
    }
    // If master left, pick first player
    const idx = playerIds.indexOf(s.masterSocketId);
    const nextIdx = (idx === -1) ? 0 : (idx + 1) % playerIds.length;
    const nextMasterSocketId = playerIds[nextIdx];
    s.masterSocketId = nextMasterSocketId;
    s.masterName = s.players[nextMasterSocketId].name;
    s.question = null;
    s.answer = null;
    s.status = 'waiting';
    Object.values(s.players).forEach(p => p.attemptsLeft = 3);
    broadcastGameState(sessionId);
    broadcastSessionsList();
    io.to(sessionId).emit('new_master', { masterSocketId: s.masterSocketId, masterName: s.masterName });
  }

  function leaveSession(socket, sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    // remove from players
    delete s.players[socket.id];
    socket.leave(sessionId);
    io.to(sessionId).emit('player_left', { socketId: socket.id });
    // if leaving was master, rotate immediately
    if (s.masterSocketId === socket.id) {
      // clear timers
      if (s.timerHandle) {
        clearInterval(s.timerHandle.intervalId);
        clearTimeout(s.timerHandle.timeoutId);
        s.timerHandle = null;
      }
      if (Object.keys(s.players).length === 0) {
        sessions.delete(sessionId);
        broadcastSessionsList();
        return;
      }
      // pick next master
      const playerIds = Object.keys(s.players);
      s.masterSocketId = playerIds[0];
      s.masterName = s.players[s.masterSocketId].name;
      s.status = 'waiting';
      s.question = null;
      s.answer = null;
      broadcastGameState(sessionId);
      broadcastSessionsList();
      io.to(sessionId).emit('new_master', { masterSocketId: s.masterSocketId, masterName: s.masterName });
    } else {
      // if no players left remove session
      if (Object.keys(s.players).length === 0) {
        sessions.delete(sessionId);
        broadcastSessionsList();
      } else {
        broadcastGameState(sessionId);
        broadcastSessionsList();
      }
    }
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});