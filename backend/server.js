const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});