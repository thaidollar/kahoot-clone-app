const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

const mockQuiz = {
  title: "Đố Vui Công Nghệ 2026",
  questions: [
    { questionText: "HTML là viết tắt của từ gì?", options: [{text:"HyperText Markup Language", isCorrect:true}, {text:"HighText Machine Language", isCorrect:false}], timeLimit: 15 },
    { questionText: "Node.js chạy trên Engine JavaScript nào?", options: [{text:"SpiderMonkey", isCorrect:false}, {text:"V8", isCorrect:true}], timeLimit: 15 }
  ]
};

const games = {};

io.on('connection', (socket) => {
  socket.on('create-game', () => {
    const pin = Math.floor(100000 + Math.random() * 900000).toString();
    games[pin] = { hostId: socket.id, quizData: mockQuiz, currentQuestionIndex: 0, players: {}, questionStartTime: 0 };
    socket.join(pin);
    socket.emit('game-created', { pin, quizTitle: mockQuiz.title });
  });

  socket.on('join-game', ({ pin, nickname }) => {
    if (!games[pin]) return socket.emit('join-error', 'Không tìm thấy phòng!');
    games[pin].players[socket.id] = { nickname, score: 0 };
    socket.join(pin);
    socket.emit('joined-successfully');
    io.to(games[pin].hostId).emit('player-joined', nickname);
  });

  socket.on('start-question', ({ pin }) => {
    const game = games[pin];
    if (!game) return;
    const currentQuestion = game.quizData.questions[game.currentQuestionIndex];
    if (!currentQuestion) return io.to(pin).emit('game-over');

    game.questionStartTime = Date.now();
    io.to(game.hostId).emit('render-question-host', { questionText: currentQuestion.questionText, options: currentQuestion.options.map(o => o.text) });
    io.to(pin).emit('show-controller');

    let timeLeft = currentQuestion.timeLimit;
    if (game.timerInterval) clearInterval(game.timerInterval);

    game.timerInterval = setInterval(() => {
      timeLeft--;
      io.to(pin).emit('timer-update', timeLeft);
      if (timeLeft <= 0) {
        clearInterval(game.timerInterval);
        const leaderboard = Object.keys(game.players).map(id => ({ nickname: game.players[id].nickname, score: game.players[id].score })).sort((a,b)=>b.score - a.score);
        io.to(pin).emit('question-ended');
        io.to(game.hostId).emit('show-leaderboard', leaderboard.slice(0, 5));
        game.currentQuestionIndex++;
      }
    }, 1000);
  });

  socket.on('submit-answer', ({ pin, answerIndex }) => {
    const game = games[pin];
    if (!game || !game.players[socket.id]) return;
    const currentQuestion = game.quizData.questions[game.currentQuestionIndex];
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
});

server.listen(PORT, () => console.log(`Server chạy trên port ${PORT}`));
