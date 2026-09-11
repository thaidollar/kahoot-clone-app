const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Đổi thành domain thật của bạn khi deploy (vd: "https://giga-quizzes.com")
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

const mockQuiz = {
  title: "Đố Vui Công Nghệ 2026",
  questions: [
    { questionText: "HTML là viết tắt của từ gì?", options: [{ text: "HyperText Markup Language", isCorrect: true }, { text: "HighText Machine Language", isCorrect: false }], timeLimit: 15 },
    { questionText: "Node.js chạy trên Engine JavaScript nào?", options: [{ text: "SpiderMonkey", isCorrect: false }, { text: "V8", isCorrect: true }], timeLimit: 15 }
  ]
};

const games = {}; // pin -> game state

function getPlayerList(game) {
  return Object.values(game.players).map(p => ({ nickname: p.nickname, score: p.score }));
}

function broadcastPlayerList(pin) {
  const game = games[pin];
  if (!game) return;
  const list = getPlayerList(game);
  io.to(game.hostId).emit('player-list-update', {
    count: list.length,
    players: list.map(p => p.nickname)
  });
}

function endGame(pin) {
  const game = games[pin];
  if (!game) return;
  if (game.timerInterval) clearInterval(game.timerInterval);
  delete games[pin];
}

io.on('connection', (socket) => {

  // ---- HOST: tạo phòng ----
  socket.on('create-game', async () => {
    let pin;
    do {
      pin = Math.floor(100000 + Math.random() * 900000).toString();
    } while (games[pin]); // tránh trùng PIN

    games[pin] = {
      hostId: socket.id,
      quizData: mockQuiz,
      currentQuestionIndex: 0,
      players: {},
      questionStartTime: 0,
      answeredThisQuestion: new Set(),
      timerInterval: null
    };
    socket.join(pin);

    const joinUrl = `${BASE_URL}/play?pin=${pin}`;
    let qrCodeDataUrl = null;
    try {
      qrCodeDataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 300 });
    } catch (err) {
      console.error('Lỗi tạo QR code:', err);
    }

    socket.emit('game-created', {
      pin,
      quizTitle: mockQuiz.title,
      joinUrl,
      qrCodeDataUrl
    });
  });

  // ---- PLAYER: tham gia phòng ----
  socket.on('join-game', ({ pin, nickname }) => {
    const cleanNick = (nickname || '').trim().slice(0, 20);
    const game = games[pin];

    if (!game) return socket.emit('join-error', 'Không tìm thấy phòng!');
    if (!cleanNick) return socket.emit('join-error', 'Vui lòng nhập tên!');
    if (game.currentQuestionIndex > 0) return socket.emit('join-error', 'Trò chơi đã bắt đầu!');

    const nameTaken = Object.values(game.players).some(
      p => p.nickname.toLowerCase() === cleanNick.toLowerCase()
    );
    if (nameTaken) return socket.emit('join-error', 'Tên này đã có người dùng, chọn tên khác!');

    game.players[socket.id] = { nickname: cleanNick, score: 0, pin };
    socket.join(pin);
    socket.emit('joined-successfully', { nickname: cleanNick });

    broadcastPlayerList(pin);
  });

  // ---- HOST: bắt đầu câu hỏi tiếp theo ----
  socket.on('start-question', ({ pin }) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;

    const currentQuestion = game.quizData.questions[game.currentQuestionIndex];
    if (!currentQuestion) {
      io.to(pin).emit('game-over');
      return endGame(pin);
    }

    game.questionStartTime = Date.now();
    game.answeredThisQuestion = new Set();

    io.to(game.hostId).emit('render-question-host', {
      questionText: currentQuestion.questionText,
      options: currentQuestion.options.map(o => o.text),
      questionNumber: game.currentQuestionIndex + 1,
      totalQuestions: game.quizData.questions.length
    });
    io.to(pin).emit('show-controller', { optionCount: currentQuestion.options.length });

    let timeLeft = currentQuestion.timeLimit;
    if (game.timerInterval) clearInterval(game.timerInterval);

    game.timerInterval = setInterval(() => {
      timeLeft--;
      io.to(pin).emit('timer-update', timeLeft);
      if (timeLeft <= 0) {
        clearInterval(game.timerInterval);
        const leaderboard = getPlayerList(game).sort((a, b) => b.score - a.score);
        io.to(pin).emit('question-ended');
        io.to(game.hostId).emit('show-leaderboard', leaderboard.slice(0, 5));
        game.currentQuestionIndex++;
      }
    }, 1000);
  });

  // ---- PLAYER: gửi câu trả lời ----
  socket.on('submit-answer', ({ pin, answerIndex }) => {
    const game = games[pin];
    if (!game || !game.players[socket.id]) return;

    // Chặn trả lời nhiều lần cho cùng 1 câu
    if (game.answeredThisQuestion.has(socket.id)) return;
    game.answeredThisQuestion.add(socket.id);

    const currentQuestion = game.quizData.questions[game.currentQuestionIndex];
    if (!currentQuestion) return;

    const timeTaken = Date.now() - game.questionStartTime;
    const isCorrect = currentQuestion.options[answerIndex]?.isCorrect;

    if (isCorrect) {
      const points = Math.max(1000 - Math.floor(timeTaken / 10), 500);
      game.players[socket.id].score += points;
      socket.emit('answer-result', { correct: true, points });
    } else {
      socket.emit('answer-result', { correct: false, points: 0 });
    }
  });

  // ---- Xử lý khi có người ngắt kết nối ----
  socket.on('disconnect', () => {
    for (const pin of Object.keys(games)) {
      const game = games[pin];

      if (game.hostId === socket.id) {
        // Host thoát -> kết thúc phòng, báo cho người chơi
        io.to(pin).emit('host-disconnected');
        endGame(pin);
        continue;
      }

      if (game.players[socket.id]) {
        delete game.players[socket.id];
        game.answeredThisQuestion.delete(socket.id);
        broadcastPlayerList(pin);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));
