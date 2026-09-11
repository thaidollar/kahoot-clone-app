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
    {
      questionText: "HTML là viết tắt của từ gì?",
      options: [
        { text: "HyperText Markup Language", isCorrect: true },
        { text: "HighText Machine Language", isCorrect: false },
        { text: "Hyperlink Text Marking Language", isCorrect: false },
        { text: "Home Tool Markup Language", isCorrect: false }
      ],
      timeLimit: 15
    },
    {
      questionText: "Node.js chạy trên Engine JavaScript nào?",
      options: [
        { text: "SpiderMonkey", isCorrect: false },
        { text: "V8", isCorrect: true },
        { text: "Chakra", isCorrect: false },
        { text: "JavaScriptCore", isCorrect: false }
      ],
      timeLimit: 15
    }
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

// Gửi câu hỏi hiện tại (dùng cho cả "Start" lần đầu lẫn "Next Question")
function askQuestion(pin) {
  const game = games[pin];
  if (!game) return;

  const currentQuestion = game.quizData.questions[game.currentQuestionIndex];
  if (!currentQuestion) {
    io.to(pin).emit('game-over');
    return endGame(pin);
  }

  game.questionStartTime = Date.now();
  game.answers = new Map(); // socketId -> answerIndex, reset mỗi câu

  const totalPlayers = Object.keys(game.players).length;

  io.to(game.hostId).emit('render-question-host', {
    questionText: currentQuestion.questionText,
    options: currentQuestion.options.map(o => o.text),
    questionNumber: game.currentQuestionIndex + 1,
    totalQuestions: game.quizData.questions.length,
    totalPlayers
  });
  io.to(pin).emit('show-controller', {
  questionText: currentQuestion.questionText,
  options: currentQuestion.options.map(o => o.text),
  questionNumber: game.currentQuestionIndex + 1,
  totalQuestions: game.quizData.questions.length,
  optionCount: currentQuestion.options.length
});

  let timeLeft = currentQuestion.timeLimit;
  if (game.timerInterval) clearInterval(game.timerInterval);

  game.timerInterval = setInterval(() => {
    timeLeft--;
    io.to(pin).emit('timer-update', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(game.timerInterval);
      game.timerInterval = null;
      revealAnswer(pin);
    }
  }, 1000);
}

// Hết giờ hoặc host bấm Skip -> tiết lộ đáp án + số lượt chọn từng phương án
function revealAnswer(pin) {
  const game = games[pin];
  if (!game) return;

  if (game.timerInterval) {
    clearInterval(game.timerInterval);
    game.timerInterval = null;
  }

  const q = game.quizData.questions[game.currentQuestionIndex];
  if (!q) return;

  const counts = q.options.map(() => 0);
  for (const answerIndex of game.answers.values()) {
    if (counts[answerIndex] !== undefined) counts[answerIndex]++;
  }
  const correctIndex = q.options.findIndex(o => o.isCorrect);

  io.to(game.hostId).emit('show-reveal', {
    questionText: q.questionText,
    options: q.options.map((o, i) => ({ text: o.text, count: counts[i] })),
    correctIndex,
    questionNumber: game.currentQuestionIndex + 1,
    totalQuestions: game.quizData.questions.length
  });

  io.to(pin).emit('question-ended');
}

io.on('connection', (socket) => {

  // ---- HOST: tạo phòng ----
  socket.on('create-game', async () => {
    let pin;
    do {
      pin = Math.floor(100000 + Math.random() * 900000).toString();
    } while (games[pin]);

    games[pin] = {
      hostId: socket.id,
      quizData: mockQuiz,
      currentQuestionIndex: 0,
      players: {},
      questionStartTime: 0,
      answers: new Map(),
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

    socket.emit('game-created', { pin, quizTitle: mockQuiz.title, joinUrl, qrCodeDataUrl });
  });

  // ---- PLAYER: tham gia phòng ----
  socket.on('join-game', ({ pin, nickname, employeeId }) => {
    const cleanNick = (nickname || '').trim().slice(0, 20);
    const cleanEmpId = (employeeId || '').trim().slice(0, 20);
    const game = games[pin];

    if (!game) return socket.emit('join-error', 'Không tìm thấy phòng!');
    if (!cleanNick) return socket.emit('join-error', 'Vui lòng nhập tên!');
    if (!cleanEmpId) return socket.emit('join-error', 'Vui lòng nhập mã số nhân viên (MSNV)!');
    if (game.currentQuestionIndex > 0 || game.timerInterval) {
      return socket.emit('join-error', 'Trò chơi đã bắt đầu!');
    }

    const nameTaken = Object.values(game.players).some(
      p => p.nickname.toLowerCase() === cleanNick.toLowerCase()
    );
    if (nameTaken) return socket.emit('join-error', 'Tên này đã có người dùng, chọn tên khác!');

    const empIdTaken = Object.values(game.players).some(
      p => p.employeeId.toLowerCase() === cleanEmpId.toLowerCase()
    );
    if (empIdTaken) return socket.emit('join-error', 'MSNV này đã tham gia phòng rồi!');

    game.players[socket.id] = { nickname: cleanNick, employeeId: cleanEmpId, score: 0, pin };
    socket.join(pin);
    socket.emit('joined-successfully', { nickname: cleanNick });

    broadcastPlayerList(pin);
  });

  // ---- HOST: bắt đầu câu hỏi đầu tiên ----
  socket.on('start-question', ({ pin }) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    askQuestion(pin);
  });

  // ---- HOST: bỏ qua thời gian còn lại, tiết lộ đáp án ngay ----
  socket.on('skip-question', ({ pin }) => {
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    revealAnswer(pin);
  });

  // ---- HOST: yêu cầu xem bảng xếp hạng (sau màn reveal) ----
 // ---- HOST: yêu cầu bảng xếp hạng ----
// Chỉ cho phép hiển thị bảng xếp hạng ở câu cuối
socket.on('request-leaderboard', ({ pin }) => {

  const game = games[pin];

  if (!game || game.hostId !== socket.id) return;

  const isLast =
    game.currentQuestionIndex + 1 >=
    game.quizData.questions.length;

  // Không cho xem leaderboard giữa game
  if (!isLast) return;

  const leaderboard =
    getPlayerList(game)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

  // GỬI CHO HOST + TẤT CẢ PLAYER
  io.to(pin).emit('show-leaderboard', {

    leaderboard,

    afterQuestionNumber:
      game.currentQuestionIndex + 1,

    totalQuestions:
      game.quizData.questions.length,

    isLast: true
  });
});

  // ---- HOST: chuyển sang câu hỏi kế tiếp ----
 socket.on('next-question', ({ pin }) => {

  const game = games[pin];

  if (!game || game.hostId !== socket.id) return;

  // Nếu đang ở câu cuối thì kết thúc game
  if (
    game.currentQuestionIndex + 1 >=
    game.quizData.questions.length
  ) {
    io.to(pin).emit('game-over');
    endGame(pin);
    return;
  }

  game.currentQuestionIndex++;

  askQuestion(pin);
});

  // ---- PLAYER: gửi câu trả lời ----
  socket.on('submit-answer', ({ pin, answerIndex }) => {
    const game = games[pin];
    if (!game || !game.players[socket.id]) return;
    if (game.answers.has(socket.id)) return; // đã trả lời rồi, chặn gửi lại

    const currentQuestion = game.quizData.questions[game.currentQuestionIndex];
    if (!currentQuestion) return;

    game.answers.set(socket.id, answerIndex);

    const timeTaken = Date.now() - game.questionStartTime;
    const isCorrect = currentQuestion.options[answerIndex]?.isCorrect;

    if (isCorrect) {
      const points = Math.max(1000 - Math.floor(timeTaken / 10), 500);
      game.players[socket.id].score += points;
      socket.emit('answer-result', { correct: true, points });
    } else {
      socket.emit('answer-result', { correct: false, points: 0 });
    }

    io.to(game.hostId).emit('answer-count-update', {
      answered: game.answers.size,
      total: Object.keys(game.players).length
    });
  });

  // ---- Xử lý khi có người ngắt kết nối ----
  socket.on('disconnect', () => {
    for (const pin of Object.keys(games)) {
      const game = games[pin];

      if (game.hostId === socket.id) {
        io.to(pin).emit('host-disconnected');
        endGame(pin);
        continue;
      }

      if (game.players[socket.id]) {
        delete game.players[socket.id];
        game.answers.delete(socket.id);
        broadcastPlayerList(pin);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));
