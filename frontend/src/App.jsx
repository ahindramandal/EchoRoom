import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io("https://echoroom-ktns.onrender.com", {
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: 8,
  reconnectionDelay: 800,
});
const iceServers = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

function App() {
  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [isInRoom, setIsInRoom] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [members, setMembers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatText, setChatText] = useState("");
  const [openMemberMenu, setOpenMemberMenu] = useState(null);
  const [userVolumes, setUserVolumes] = useState({});

  const [micOn, setMicOn] = useState(false);
  const [deafenOn, setDeafenOn] = useState(false);
  const [screenOn, setScreenOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenShares, setScreenShares] = useState([]);

  const [pushToTalkOn, setPushToTalkOn] = useState(false);
  const [pttKey, setPttKey] = useState("v");
  const [isSettingKey, setIsSettingKey] = useState(false);

  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const peersRef = useRef({});
  const remoteAudioRef = useRef({});
  const userVolumesRef = useRef({});
  const chatEndRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const speakingRef = useRef(false);
  const speakingIntervalRef = useRef(null);
  const micOnRef = useRef(false);

  const pushToTalkOnRef = useRef(false);
  const pttKeyRef = useRef("v");
  const pttHoldingRef = useRef(false);

  const [message, setMessage] = useState(
    "Build your squad. Enter the battlefield."
  );

  useEffect(() => {
    pushToTalkOnRef.current = pushToTalkOn;
    pttKeyRef.current = pttKey.toLowerCase();
  }, [pushToTalkOn, pttKey]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages]);

  useEffect(() => {
    userVolumesRef.current = userVolumes;

    Object.entries(remoteAudioRef.current).forEach(([socketId, audio]) => {
      audio.volume = deafenOn ? 0 : userVolumes[socketId] ?? 1;
    });
  }, [userVolumes, deafenOn]);

  const updateMemberStatus = (nextMicOn = micOn, nextDeafenOn = deafenOn) => {
    if (!roomId) return;

    socket.emit("member-status", {
      roomId,
      micOn: nextMicOn,
      deafenOn: nextDeafenOn,
    });
  };

  const emitSpeakingStatus = (speaking) => {
    if (!roomId || speakingRef.current === speaking) return;

    speakingRef.current = speaking;

    socket.emit("speaking-status", {
      roomId,
      speaking,
    });
  };

  const startSpeakingDetection = (stream) => {
    stopSpeakingDetection();

    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);

      analyser.fftSize = 512;
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      speakingIntervalRef.current = setInterval(() => {
        if (!analyserRef.current || !micOnRef.current) {
          emitSpeakingStatus(false);
          return;
        }

        analyserRef.current.getByteFrequencyData(dataArray);

        const average =
          dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;

        emitSpeakingStatus(average > 18);
      }, 180);
    } catch (error) {
      console.error("Speaking detection error:", error);
    }
  };

  const stopSpeakingDetection = () => {
    if (speakingIntervalRef.current) {
      clearInterval(speakingIntervalRef.current);
      speakingIntervalRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    analyserRef.current = null;
    emitSpeakingStatus(false);
  };

  const createAudioElement = (socketId, stream) => {
    const existingAudio = remoteAudioRef.current[socketId];

    if (existingAudio) {
      if (existingAudio.srcObject !== stream) {
        existingAudio.srcObject = stream;
      }

      existingAudio.volume = deafenOn ? 0 : userVolumesRef.current[socketId] ?? 1;
      existingAudio.play?.().catch(() => {});
      return;
    }

    const audio = document.createElement("audio");
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.volume = deafenOn ? 0 : userVolumesRef.current[socketId] ?? 1;
    document.body.appendChild(audio);

    audio.play?.().catch(() => {});
    remoteAudioRef.current[socketId] = audio;
  };
  const createScreenElement = (socketId, stream, type = "screen", customId = null) => {
    const videoTrack = stream?.getVideoTracks?.()[0];
    const id = customId || `${socketId}-${type}-${videoTrack?.id || "video"}`;

    setScreenShares((prev) => {
      const exists = prev.some((item) => item.id === id);

      if (exists) {
        return prev.map((item) =>
          item.id === id
            ? { ...item, socketId, stream, type, trackId: videoTrack?.id }
            : item
        );
      }

      return [
        ...prev,
        {
          id,
          socketId,
          stream,
          type,
          trackId: videoTrack?.id,
        },
      ];
    });
  };

  const removeScreenElement = (socketIdOrId) => {
    setScreenShares((prev) =>
      prev.filter(
        (item) => item.socketId !== socketIdOrId && item.id !== socketIdOrId
      )
    );
  };

  const removeRemoteVideoTrack = (socketId, trackId) => {
    setScreenShares((prev) =>
      prev.filter(
        (item) => !(item.socketId === socketId && item.trackId === trackId)
      )
    );
  };

  const makeOffer = async (targetSocketId) => {
    const peer = createPeerConnection(targetSocketId);

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    socket.emit("voice-offer", {
      to: targetSocketId,
      offer,
    });
  };

  const callAllMembers = async () => {
    const otherMembers = members.filter(
      (member) => member.socketId !== socket.id
    );

    for (const member of otherMembers) {
      await makeOffer(member.socketId);
    }
  };

  const attachScreenToPeersAndOffer = async (screenStream) => {
    const screenTracks = screenStream.getTracks();
    const screenVideoTrack = screenStream.getVideoTracks()[0];

    if (!screenVideoTrack) return;

    const otherMembers = members.filter(
      (member) => member.socketId !== socket.id
    );

    for (const member of otherMembers) {
      const peer = createPeerConnection(member.socketId);

      screenTracks.forEach((track) => {
        const alreadyAdded = peer
          .getSenders()
          .some((sender) => sender.track === track);

        if (!alreadyAdded) {
          peer.addTrack(track, screenStream);
        }
      });

      await makeOffer(member.socketId);
    }
  };

  const stopScreenShare = async (silent = false) => {
    const oldScreenStream = screenStreamRef.current;
    const oldScreenTracks = oldScreenStream ? oldScreenStream.getTracks() : [];

    removeScreenElement("local-screen");
    setScreenOn(false);

    for (const [socketId, peer] of Object.entries(peersRef.current)) {
      const screenSenders = peer
        .getSenders()
        .filter((sender) => {
          if (!sender.track) return false;

          return oldScreenTracks.includes(sender.track);
        });

      screenSenders.forEach((sender) => {
        try {
          peer.removeTrack(sender);
        } catch (error) {
          console.error("Remove screen track error:", error);
        }
      });

      await makeOffer(socketId);
    }

    oldScreenTracks.forEach((track) => track.stop());
    screenStreamRef.current = null;

    if (!silent && roomId) {
      socket.emit("screen-share-stopped", { roomId });
    }

    setMessage("Screen sharing stopped.");
  };


  const attachCameraToPeersAndOffer = async (cameraStream) => {
    const cameraTrack = cameraStream.getVideoTracks()[0];
    if (!cameraTrack) return;

    const otherMembers = members.filter(
      (member) => member.socketId !== socket.id
    );

    for (const member of otherMembers) {
      const peer = createPeerConnection(member.socketId);

      const alreadyAdded = peer
        .getSenders()
        .some((sender) => sender.track === cameraTrack);

      if (!alreadyAdded) {
        peer.addTrack(cameraTrack, cameraStream);
      }

      await makeOffer(member.socketId);
    }
  };

  const stopCamera = async (silent = false) => {
    const oldCameraStream = cameraStreamRef.current;
    const oldCameraTracks = oldCameraStream ? oldCameraStream.getTracks() : [];

    removeScreenElement("local-camera");
    setCameraOn(false);

    for (const [socketId, peer] of Object.entries(peersRef.current)) {
      const cameraSenders = peer
        .getSenders()
        .filter((sender) => sender.track && oldCameraTracks.includes(sender.track));

      cameraSenders.forEach((sender) => {
        try {
          peer.removeTrack(sender);
        } catch (error) {
          console.error("Remove camera track error:", error);
        }
      });

      if (cameraSenders.length > 0) {
        await makeOffer(socketId);
      }
    }

    oldCameraTracks.forEach((track) => track.stop());
    cameraStreamRef.current = null;

    if (!silent && roomId) {
      socket.emit("camera-stopped", { roomId });
    }

    if (!silent) {
      setMessage("Camera stopped.");
    }
  };

  const toggleCamera = async () => {
    try {
      if (cameraOn) {
        await stopCamera();
        return;
      }

      const cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      cameraStreamRef.current = cameraStream;
      setCameraOn(true);
      createScreenElement("camera-local", cameraStream, "camera", "local-camera");

      const cameraTrack = cameraStream.getVideoTracks()[0];
      if (cameraTrack) {
        cameraTrack.onended = () => {
          stopCamera();
        };
      }

      await attachCameraToPeersAndOffer(cameraStream);
      socket.emit("camera-started", { roomId });
      socket.emit("member-status", { roomId, micOn, deafenOn, cameraOn: true });
      setMessage("Camera started.");
    } catch (error) {
      console.error("Camera error:", error);
      setCameraOn(false);

      if (error?.name === "NotAllowedError") {
        setMessage("Camera permission denied.");
      } else if (error?.name === "NotFoundError") {
        setMessage("No webcam found. Use phone as webcam with Iriun/DroidCam.");
      } else {
        setMessage(`Camera failed: ${error?.message || "Unknown error"}`);
      }
    }
  };

  const removePeer = (socketId) => {
    if (peersRef.current[socketId]) {
      peersRef.current[socketId].close();
      delete peersRef.current[socketId];
      setScreenShares((prev) => prev.filter((item) => item.socketId !== socketId));
    }

    if (remoteAudioRef.current[socketId]) {
      remoteAudioRef.current[socketId].remove();
      delete remoteAudioRef.current[socketId];
    }
  };

  const createPeerConnection = (targetSocketId) => {
    if (peersRef.current[targetSocketId]) {
      return peersRef.current[targetSocketId];
    }

    const peer = new RTCPeerConnection(iceServers);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current);
      });
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        peer.addTrack(track, screenStreamRef.current);
      });
    }

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getVideoTracks().forEach((track) => {
        peer.addTrack(track, cameraStreamRef.current);
      });
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", {
          to: targetSocketId,
          candidate: event.candidate,
        });
      }
    };

    peer.ontrack = (event) => {
      const [remoteStream] = event.streams;
      const track = event.track;

      if (track.kind === "audio") {
        createAudioElement(targetSocketId, remoteStream);
      }

      if (track.kind === "video") {
        const videoOnlyStream = new MediaStream([track]);
        const remoteVideoId = `${targetSocketId}-video-${track.id}`;

        createScreenElement(
          targetSocketId,
          videoOnlyStream,
          "remote-video",
          remoteVideoId
        );

        track.onended = () => removeRemoteVideoTrack(targetSocketId, track.id);
        track.onmute = () => removeRemoteVideoTrack(targetSocketId, track.id);
      }
    };

    peer.onconnectionstatechange = () => {
      if (
        peer.connectionState === "failed" ||
        peer.connectionState === "disconnected" ||
        peer.connectionState === "closed"
      ) {
        removePeer(targetSocketId);
      }
    };

    peersRef.current[targetSocketId] = peer;
    return peer;
  };

  const callUser = async (targetSocketId) => {
    await makeOffer(targetSocketId);
  };

  const attachMicToExistingPeers = async (stream) => {
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    for (const [socketId, peer] of Object.entries(peersRef.current)) {
      const hasAudioSender = peer
        .getSenders()
        .some((sender) => sender.track && sender.track.kind === "audio");

      if (!hasAudioSender) {
        audioTracks.forEach((track) => {
          peer.addTrack(track, stream);
        });
      }

      await makeOffer(socketId);
    }
  };

  const startMic = async () => {
    try {
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });

        micOnRef.current = true;
        setMicOn(true);
        updateMemberStatus(true, deafenOn);
        startSpeakingDetection(localStreamRef.current);
        await attachMicToExistingPeers(localStreamRef.current);
        return localStreamRef.current;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      localStreamRef.current = stream;

      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });

      micOnRef.current = true;
      setMicOn(true);
      setMessage("Mic active. Voice system ready.");

      socket.emit("member-status", {
        roomId,
        micOn: true,
        deafenOn,
      });

      socket.emit("voice-ready", { roomId });

      startSpeakingDetection(stream);
      await attachMicToExistingPeers(stream);

      return stream;
    } catch (error) {
      console.error(error);
      micOnRef.current = false;
      setMicOn(false);
      setMessage("Mic permission denied or microphone not found.");
      return null;
    }
  };

  const stopMic = () => {
    micOnRef.current = false;
    stopSpeakingDetection();

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    Object.keys(peersRef.current).forEach((socketId) => removePeer(socketId));

    setMicOn(false);

    if (roomId) {
      socket.emit("member-status", {
        roomId,
        micOn: false,
        deafenOn,
      });
    }
  };

  const toggleMic = async () => {
    if (pushToTalkOn) {
      setMessage("Push-to-talk is ON. Hold your PTT key to speak.");
      return;
    }

    if (!localStreamRef.current) {
      await startMic();
      return;
    }

    const audioTracks = localStreamRef.current.getAudioTracks();
    const newMicState = !micOn;

    audioTracks.forEach((track) => {
      track.enabled = newMicState;
    });

    micOnRef.current = newMicState;
    setMicOn(newMicState);
    updateMemberStatus(newMicState, deafenOn);

    if (newMicState) {
      startSpeakingDetection(localStreamRef.current);
    } else {
      stopSpeakingDetection();
    }

    setMessage(newMicState ? "Mic unmuted." : "Mic muted.");
  };

  const enableMicForPTT = async () => {
    if (!localStreamRef.current) {
      const stream = await startMic();

      if (stream) {
        stream.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });

        micOnRef.current = true;
        setMicOn(true);
        updateMemberStatus(true, deafenOn);
        startSpeakingDetection(stream);
      }

      return;
    }

    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });

    micOnRef.current = true;
    setMicOn(true);
    updateMemberStatus(true, deafenOn);
    startSpeakingDetection(localStreamRef.current);
  };

  const disableMicForPTT = () => {
    if (!localStreamRef.current) {
      micOnRef.current = false;
      setMicOn(false);
      updateMemberStatus(false, deafenOn);
      return;
    }

    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });

    micOnRef.current = false;
    setMicOn(false);
    stopSpeakingDetection();
    updateMemberStatus(false, deafenOn);
  };

  const togglePushToTalk = () => {
    const next = !pushToTalkOn;

    setPushToTalkOn(next);

    if (next) {
      disableMicForPTT();
      setMessage(`Push-to-talk enabled. Hold "${pttKey.toUpperCase()}" to speak.`);
    } else {
      setMessage("Push-to-talk disabled. Normal mic mode enabled.");
    }
  };
const toggleScreenShare = async () => {
  try {
    if (screenOn) {
      await stopScreenShare();
      return;
    }

    // Stable screen capture.
    // Browser support for system audio is different for Entire Screen / Tab / Window,
    // so first try with audio, then fall back to video-only instead of failing.
    let screenStream;

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch (firstError) {
      console.warn("Screen share with audio failed, trying video only:", firstError);

      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    }

    if (!screenStream || screenStream.getVideoTracks().length === 0) {
      setMessage("Screen sharing failed. No screen video track found.");
      return;
    }

    screenStreamRef.current = screenStream;

    const screenTrack = screenStream.getVideoTracks()[0];

    screenTrack.onended = () => {
      stopScreenShare();
    };

    setScreenOn(true);
    createScreenElement("local", screenStream, "screen", "local-screen");

    // Important: screen share should work even if mic is already connected or mic is off.
    // Existing peers need the new video track added before renegotiation.
    await attachScreenToPeersAndOffer(screenStream);

    socket.emit("screen-share-started", { roomId });
    const hasSystemAudio = screenStream.getAudioTracks().length > 0;
    setMessage(
      hasSystemAudio
        ? "Screen sharing with system audio started."
        : "Screen sharing started. Select Entire Screen/Tab with audio to share game or video sound."
    );
  } catch (error) {
    console.error("Screen sharing error:", error);

    if (error?.name === "NotAllowedError") {
      setMessage("Screen sharing cancelled or permission denied.");
    } else {
      setMessage(`Screen sharing failed: ${error?.message || "Unknown error"}`);
    }
  }
};

  const toggleDeafen = () => {
    const newState = !deafenOn;
    setDeafenOn(newState);

    Object.values(remoteAudioRef.current).forEach((audio) => {
      const socketId = Object.keys(remoteAudioRef.current).find((id) => remoteAudioRef.current[id] === audio);
      audio.volume = newState ? 0 : userVolumesRef.current[socketId] ?? 1;
    });

    updateMemberStatus(micOn, newState);
    setMessage(newState ? "Deafen enabled." : "Deafen disabled.");
  };

  const changeUserVolume = (socketId, value) => {
    const volume = Number(value);
    setUserVolumes((prev) => ({ ...prev, [socketId]: volume }));

    if (remoteAudioRef.current[socketId]) {
      remoteAudioRef.current[socketId].volume = deafenOn ? 0 : volume;
    }
  };

  const sendChatMessage = () => {
    const text = chatText.trim();
    if (!text || !roomId) return;

    socket.emit("send-chat-message", { roomId, text, username });
    setChatText("");
  };

  const hostSetMic = (targetSocketId, nextMicOn) => {
    if (!isHost || targetSocketId === socket.id) return;
    socket.emit("host-set-mic", { roomId, targetSocketId, micOn: nextMicOn });
    setOpenMemberMenu(null);
  };

  const hostSetDeafen = (targetSocketId, nextDeafenOn) => {
    if (!isHost || targetSocketId === socket.id) return;
    socket.emit("host-set-deafen", { roomId, targetSocketId, deafenOn: nextDeafenOn });
    setOpenMemberMenu(null);
  };

  const hostKickMember = (targetSocketId) => {
    if (!isHost || targetSocketId === socket.id) return;
    socket.emit("host-kick-member", { roomId, targetSocketId });
    setOpenMemberMenu(null);
  };

  useEffect(() => {
    const handleKeyDown = async (e) => {
      if (isSettingKey) return;
      if (!pushToTalkOnRef.current) return;
      if (e.repeat) return;

      if (e.key.toLowerCase() === pttKeyRef.current) {
        pttHoldingRef.current = true;
        await enableMicForPTT();
        setMessage("Push-to-talk active.");
      }
    };

    const handleKeyUp = (e) => {
      if (isSettingKey) return;
      if (!pushToTalkOnRef.current) return;

      if (e.key.toLowerCase() === pttKeyRef.current) {
        pttHoldingRef.current = false;
        disableMicForPTT();
        setMessage("Push-to-talk released.");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [isSettingKey, deafenOn, roomId]);

  useEffect(() => {
    const setCustomKey = (e) => {
      if (!isSettingKey) return;

      e.preventDefault();

      setPttKey(e.key.toLowerCase());
      setIsSettingKey(false);
      setMessage(`Push-to-talk key set to "${e.key.toUpperCase()}".`);
    };

    window.addEventListener("keydown", setCustomKey);

    return () => {
      window.removeEventListener("keydown", setCustomKey);
    };
  }, [isSettingKey]);

  useEffect(() => {
    socket.on("connect", () => console.log("Connected:", socket.id));

    socket.on("room-created", (data) => {
      setIsInRoom(true);
      setIsHost(true);
      setRoomId(data.roomId);
      setMembers(data.members || []);
      setChatMessages([]);
      setMessage("Room ready. Share the Room ID with your squad.");
    });

    socket.on("incoming-request", (data) => {
      setRequests((prev) => {
        const exists = prev.some((item) => item.socketId === data.socketId);
        return exists ? prev : [...prev, data];
      });
    });

    socket.on("request-sent", () => {
      setMessage("Request sent. Waiting for host approval.");
    });

    socket.on("request-approved", (data) => {
      setIsInRoom(true);
      setIsHost(false);
      setRoomId(data.roomId);
      setMembers(data.members || []);
      setChatMessages([]);
      setMessage("Access granted. Squad channel unlocked.");
    });

    socket.on("members-updated", (data) => setMembers(data || []));
    socket.on("join-error", (error) => setMessage(error));

    socket.on("room-closed", (data) => {
      stopMic();
      stopScreenShare(true);
      stopCamera(true);
      setIsInRoom(false);
      setIsHost(false);
      setMembers([]);
      setRequests([]);
      setChatMessages([]);
      setChatText("");
      setRoomId("");
      setDeafenOn(false);
      setScreenOn(false);
      setCameraOn(false);
      setPushToTalkOn(false);
      setMessage(data?.message || "Host left. Room closed.");
    });

    socket.on("screen-share-stopped", ({ socketId }) => {
      removeScreenElement(socketId);
    });


    const handleChatMessage = (chatMessage) => {
      const normalizedMessage = {
        id:
          chatMessage.id ||
          `${chatMessage.socketId || chatMessage.username}-${chatMessage.time}-${chatMessage.text || chatMessage.message}`,
        socketId: chatMessage.socketId,
        username: chatMessage.username || "User",
        text: chatMessage.text ?? chatMessage.message ?? "",
        time: chatMessage.time || "",
      };

      setChatMessages((prev) => {
        const exists = prev.some((item) => item.id === normalizedMessage.id);
        if (exists) return prev;
        return [...prev.slice(-60), normalizedMessage];
      });
    };

    socket.on("chat-message", handleChatMessage);
    socket.on("receive-message", handleChatMessage);

    socket.on("force-mic-state", async ({ micOn: nextMicOn }) => {
      if (nextMicOn) {
        setPushToTalkOn(false);
        const stream = await startMic();

        if (stream) {
          stream.getAudioTracks().forEach((track) => {
            track.enabled = true;
          });

          micOnRef.current = true;
          setMicOn(true);
          updateMemberStatus(true, deafenOn);
          startSpeakingDetection(stream);
          setMessage("Host unmuted your mic.");
        }

        return;
      }

      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      }

      micOnRef.current = false;
      setMicOn(false);
      stopSpeakingDetection();
      updateMemberStatus(false, deafenOn);
      setMessage("Host muted your mic.");
    });

    socket.on("force-deafen-state", ({ deafenOn: nextDeafenOn }) => {
      setDeafenOn(nextDeafenOn);
      Object.entries(remoteAudioRef.current).forEach(([socketId, audio]) => {
        audio.volume = nextDeafenOn ? 0 : userVolumesRef.current[socketId] ?? 1;
      });
      updateMemberStatus(micOnRef.current, nextDeafenOn);
      setMessage(nextDeafenOn ? "Host deafened your audio." : "Host undeafened your audio.");
    });

    socket.on("kicked-from-room", (data) => {
      stopMic();
      stopScreenShare(true);
      stopCamera(true);
      setIsInRoom(false);
      setIsHost(false);
      setMembers([]);
      setRequests([]);
      setChatMessages([]);
      setChatText("");
      setRoomId("");
      setDeafenOn(false);
      setScreenOn(false);
      setCameraOn(false);
      setPushToTalkOn(false);
      setMessage(data?.message || "You were removed from the room.");
    });

    socket.on("left-room", () => {
      stopMic();
      stopScreenShare(true);
      stopCamera(true);
      setIsInRoom(false);
      setIsHost(false);
      setMembers([]);
      setRequests([]);
      setChatMessages([]);
      setChatText("");
      setRoomId("");
      setDeafenOn(false);
      setScreenOn(false);
      setCameraOn(false);
      setPushToTalkOn(false);
      setMessage("You left the room.");
    });

    socket.on("voice-users", async (users) => {
      if (!localStreamRef.current && !screenStreamRef.current && !cameraStreamRef.current) return;

      for (const user of users) {
        await callUser(user.socketId);
      }
    });

    socket.on("new-voice-user", async ({ socketId }) => {
      if (!localStreamRef.current && !screenStreamRef.current && !cameraStreamRef.current) return;
      await callUser(socketId);
    });

    socket.on("voice-offer", async ({ from, offer }) => {
      const peer = createPeerConnection(from);
      await peer.setRemoteDescription(new RTCSessionDescription(offer));

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      socket.emit("voice-answer", {
        to: from,
        answer,
      });
    });

    socket.on("voice-answer", async ({ from, answer }) => {
      const peer = peersRef.current[from];
      if (!peer) return;

      await peer.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on("ice-candidate", async ({ from, candidate }) => {
      const peer = peersRef.current[from];
      if (!peer) return;

      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error("ICE candidate error:", error);
      }
    });

    socket.on("user-left-voice", ({ socketId }) => {
      removePeer(socketId);
    });

    return () => {
      socket.off("connect");
      socket.off("room-created");
      socket.off("incoming-request");
      socket.off("request-sent");
      socket.off("request-approved");
      socket.off("members-updated");
      socket.off("join-error");
      socket.off("room-closed");
      socket.off("screen-share-stopped");
      socket.off("chat-message");
      socket.off("receive-message");
      socket.off("force-mic-state");
      socket.off("force-deafen-state");
      socket.off("kicked-from-room");
      socket.off("left-room");
      socket.off("voice-users");
      socket.off("new-voice-user");
      socket.off("voice-offer");
      socket.off("voice-answer");
      socket.off("ice-candidate");
      socket.off("user-left-voice");
    };
  }, [roomId, micOn, deafenOn, pushToTalkOn, isSettingKey]);

  const createRoom = () => {
    if (!username.trim()) {
      setMessage("Username required to create room");
      return;
    }

    socket.emit("create-room", {
      username: username.trim(),
    });
  };

  const joinRoom = () => {
    if (!username.trim() || !roomId.trim()) {
      setMessage("Username and Room ID required");
      return;
    }

    socket.emit("join-request", {
      username: username.trim(),
      roomId: roomId.trim(),
    });
  };

  const approveRequest = (request) => {
    socket.emit("approve-request", {
      roomId: request.roomId,
      socketId: request.socketId,
      username: request.username,
    });

    setRequests((prev) =>
      prev.filter((item) => item.socketId !== request.socketId)
    );
  };

  const rejectRequest = (request) => {
    socket.emit("reject-request", {
      roomId: request.roomId,
      socketId: request.socketId,
    });

    setRequests((prev) =>
      prev.filter((item) => item.socketId !== request.socketId)
    );
  };

  const leaveRoom = () => {
    stopScreenShare(true);
    stopCamera(true);
    stopMic();
    socket.emit("leave-room", { roomId });
  };

  const responsiveVideoStyles = ``;

  const animalTypes = [
    "pegasus",
    "phoenix",
    "dragon",
    "wolf",
    "deer",
    "lion",
    "raven",
    "shark",
    "crocodile",
    "scorpion",
  ];

  const getAnimalType = (index) => animalTypes[index % animalTypes.length];

  const getTileAccent = (index) => {
    const accents = ["blue", "orange", "green", "purple", "gold", "red", "violet", "cyan"];
    return accents[index % accents.length];
  };

  const AnimalLogo = ({ type = "dragon" }) => {
    const icons = {
      dragon: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece logo-back" d="M24 83c18-35 40-55 73-62-8 8-10 17-8 27 8-1 15 2 20 9-11 1-18 5-23 12 8 3 14 9 18 18-16-5-30-5-43 1-13 6-25 6-37-5Z" />
          <path className="logo-piece" d="M18 75c11-31 36-53 72-65-4 12-3 22 5 31-18 0-32 4-43 13 15-3 29-2 42 4-9 7-18 13-28 17 6 12 16 22 30 31-27-2-49-13-66-32-4 5-8 5-12 1Z" />
          <path className="logo-cut" d="M58 43c6-6 14-10 25-11-8 5-12 10-14 16-5-2-9-3-11-5Z" />
          <path className="logo-cut" d="M78 58l23 3-23 7c-3-4-3-7 0-10Z" />
          <path className="logo-eye" d="M80 46l7 2-7 3Z" />
        </svg>
      ),
      phoenix: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece logo-back" d="M58 18c-18 16-29 32-33 49 12-9 25-13 40-13 12 0 23 4 33 13-4-18-17-35-40-49Z" />
          <path className="logo-piece" d="M60 12c-4 15-2 29 5 43 7-16 19-28 37-36-4 19-14 34-29 45 12 1 24 6 37 14-23 7-42 4-57-9-12 13-30 17-53 10 14-8 27-14 40-16-15-12-25-26-30-44 18 8 30 20 37 36 8-14 10-28 7-43Z" />
          <path className="logo-cut" d="M61 42c9 2 16 7 20 15-7-3-14-4-22-3 2-5 2-9 2-12Z" />
          <path className="logo-eye" d="M65 30l5 3-6 2Z" />
          <path className="logo-piece logo-tail" d="M52 70c-1 17-8 28-22 36 17-2 30-9 39-23 0-7-6-11-17-13Z" />
        </svg>
      ),
      pegasus: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece logo-back" d="M20 71c16-27 37-44 64-52-4 10-4 20 1 31 12 2 21 9 28 19-15-5-28-4-39 3-18 11-36 10-54-1Z" />
          <path className="logo-piece" d="M15 76c20-37 48-56 83-58-7 8-11 16-11 25 11 2 20 9 28 20-16-4-30-3-41 5-12 9-24 14-37 13l9 19c-15-3-25-11-31-24Z" />
          <path className="logo-cut" d="M48 39c8-9 20-14 36-16-11 8-18 17-21 28-6-5-11-9-15-12Z" />
          <path className="logo-cut" d="M78 55l25 5-25 8c-4-5-4-9 0-13Z" />
          <path className="logo-eye" d="M79 43l6 2-6 3Z" />
        </svg>
      ),
      wolf: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece" d="M20 73c8-31 29-49 64-54l11-13 2 23c12 8 18 20 18 36-11-7-24-9-39-6 11 8 19 20 24 35-22-4-39-15-51-34-7 8-17 12-29 13Z" />
          <path className="logo-cut" d="M60 39c8-6 17-9 29-9-8 5-13 11-16 19-5-4-9-7-13-10Z" />
          <path className="logo-eye" d="M77 45l8 2-8 3Z" />
        </svg>
      ),
      deer: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece" d="M60 100c-18-18-26-36-21-54L18 24l27 8L49 8l14 25L78 8l-4 24 28-8-22 22c5 19-2 37-20 54Z" />
          <path className="logo-cut" d="M50 48h20l-10 20Z" />
          <path className="logo-eye" d="M45 55l7 2-7 3Zm23 0l7 2-7 3Z" />
        </svg>
      ),
      lion: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece" d="M16 69c14-31 39-49 75-54-2 10 1 19 8 27 9 10 13 22 12 36-17-11-33-13-50-7 10 9 19 19 27 32-28-4-51-15-72-34Z" />
          <path className="logo-cut" d="M57 42c9-8 20-12 35-12-10 7-17 14-21 23-5-5-10-9-14-11Z" />
          <path className="logo-eye" d="M78 48l8 2-8 4Z" />
        </svg>
      ),
      raven: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece" d="M12 71c28-29 58-44 90-46-9 9-14 19-16 31l25 9-29 6c-14 19-36 26-70 0Z" />
          <path className="logo-cut" d="M50 44c12-7 24-10 38-10-11 5-19 12-24 22-5-5-9-9-14-12Z" />
          <path className="logo-eye" d="M75 45l7 2-7 3Z" />
        </svg>
      ),
      shark: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece" d="M10 70c30-30 65-43 105-40-11 7-19 15-25 25l24 9-29 7c-18 18-43 18-75-1Z" />
          <path className="logo-cut" d="M63 50l34 7-34 9c-5-6-5-11 0-16Z" />
          <path className="logo-eye" d="M77 42l7 2-7 3Z" />
        </svg>
      ),
      crocodile: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece" d="M8 70c26-25 58-38 96-39l10 12-26 9 24 9-30 7c-20 18-45 19-74 2Z" />
          <path className="logo-cut" d="M58 51h50L80 64c-9-2-16-6-22-13Z" />
          <path className="logo-eye" d="M80 42l8 2-8 3Z" />
        </svg>
      ),
      scorpion: (
        <svg viewBox="0 0 120 120" className="animal-svg-inline" aria-hidden="true">
          <path className="logo-piece" d="M62 18c24 11 37 29 39 54l13 9-17 7c-9 17-25 24-48 22 12-8 19-18 21-30-13 8-30 10-52 5 22-11 35-24 40-38l-20-7 24-22Z" />
          <path className="logo-cut" d="M61 44c9 4 15 12 18 23-8-5-16-7-25-8 5-5 7-10 7-15Z" />
        </svg>
      ),
    };

    return (
      <span className={`animal-svg animal-${type} real-animal-logo`} aria-hidden="true">
        <span className="animal-logo-disc">
          {icons[type] || icons.dragon}
        </span>
      </span>
    );
  };

  const renderStatusIcons = (member) => (
    <div className="tile-status-icons">
      <span className={member.micOn ? "status-dot mic-on" : "status-dot mic-off"} title={member.micOn ? "Mic on" : "Muted"}>
        {member.micOn ? "🎙" : "🎙"}
      </span>
      <span className={member.deafenOn ? "status-dot deaf-on" : "status-dot deaf-off"} title={member.deafenOn ? "Deafened" : "Not deafened"}>
        🎧
      </span>
      <span className={member.cameraOn ? "status-dot cam-on" : "status-dot cam-off"} title={member.cameraOn ? "Camera on" : "Camera off"}>
        ▣
      </span>
    </div>
  );

  return (
    <div className="app echoroom-next">
      <style>{responsiveVideoStyles}</style>
      <div className="sky"></div>
      <div className="split-glow split-blue"></div>
      <div className="split-glow split-orange"></div>
      <div className="bg-creature bg-dragon"><AnimalLogo type="dragon" /></div>
      <div className="bg-creature bg-phoenix"><AnimalLogo type="phoenix" /></div>
      <div className="particle-field">
        {Array.from({ length: 28 }).map((_, index) => (
          <span key={index} className={`particle p${(index % 8) + 1}`}></span>
        ))}
      </div>

      <div className="credit">Designed & Developed by Ahindra Mandal</div>

      {!isInRoom ? (
        <div className="card login-card-next">
          <div className="brand-pegasus"><AnimalLogo type="pegasus" /></div>
          <h1>ECHO<span>ROOM</span></h1>
          <p className="tagline">SQUAD UP • LOCK IN • DOMINATE</p>

          <input type="text" placeholder="Enter Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="text" placeholder="Enter Room ID to Join" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          <button className="main-btn" onClick={joinRoom}>REQUEST TO JOIN</button>
          <button className="secondary-btn" onClick={createRoom}>CREATE ROOM</button>
          <p className="status">{message}</p>
        </div>
      ) : (
        <div className="room-shell-next">
          <header className="topbar-next">
            <div className="room-id-block">
              <span>Room ID:</span>
              <b>{roomId}</b>
            </div>

            <div className="center-brand-next">
              <div className="brand-pegasus small"><AnimalLogo type="pegasus" /></div>
              <strong>ECHOROOM</strong>
              <small>{message}</small>
            </div>

            <div className="badge host-badge-next">{isHost ? "HOST" : "MEMBER"}</div>
          </header>

          <main className="room-stage-next">
            <section className="main-member-window">
              <div className={`member-media-grid grid-total-${Math.min(members.length + screenShares.length, 9)}`}>
                {members.map((member, index) => {
                  const isMe = member.socketId === socket.id;
                  const volumeValue = userVolumes[member.socketId] ?? 1;
                  const animal = getAnimalType(index);
                  const accent = getTileAccent(index);
                  const memberShare = screenShares.find((share) => {
                    if (isMe) {
                      return (
                        share.socketId === "local" ||
                        share.socketId === "camera-local" ||
                        share.id === "local-screen" ||
                        share.id === "local-camera"
                      );
                    }

                    return share.socketId === member.socketId;
                  });
                  const hasMedia = Boolean(memberShare);

                  return (
                    <div className={`member-tile accent-${accent} ${member.speaking ? "speaking" : ""} ${hasMedia ? "media-active" : ""}`} key={member.socketId}>
                      <button
                        className="tile-menu-btn"
                        onClick={() =>
                          setOpenMemberMenu((current) =>
                            current === member.socketId ? null : member.socketId
                          )
                        }
                      >⋯</button>

                      {(isHost && !isMe) && openMemberMenu === member.socketId && (
                        <div className="host-menu tile-host-menu">
                          <button onClick={() => hostSetMic(member.socketId, !member.micOn)}>{member.micOn ? "Mute" : "Unmute"}</button>
                          <button onClick={() => hostSetDeafen(member.socketId, !member.deafenOn)}>{member.deafenOn ? "Undeafen" : "Deafen"}</button>
                          <button className="danger" onClick={() => hostKickMember(member.socketId)}>Kick</button>
                        </div>
                      )}

                      {hasMedia ? (
                        <div className="tile-media-wrap">
                          <video
                            className="tile-video embedded-tile-video"
                            autoPlay
                            playsInline
                            muted={isMe}
                            onDoubleClick={(e) => e.currentTarget.requestFullscreen?.()}
                            ref={(video) => {
                              if (video && video.srcObject !== memberShare.stream) {
                                video.srcObject = memberShare.stream;
                              }
                            }}
                          />
                          <span className="tile-top-tag">{memberShare.type === "camera" ? "CAM" : "LIVE"}</span>
                        </div>
                      ) : (
                        <div className={`animal-circle ${member.speaking ? "talking" : ""}`}>
                          <AnimalLogo type={animal} />
                        </div>
                      )}

                      <div className="tile-name-row">
                        <b>{member.username}</b>
                        {member.role === "Host" && <span className="role-chip">HOST</span>}
                        {isMe && <span className="you-chip">YOU</span>}
                      </div>

                      {member.speaking ? (
                        <div className="voice-bars active"><span></span><span></span><span></span><span></span><span></span></div>
                      ) : (
                        <div className="voice-bars"><span></span><span></span><span></span><span></span><span></span></div>
                      )}

                      {renderStatusIcons(member)}

                      {!isMe && (
                        <label className="tile-volume" title="Local volume">
                          <span>VOL</span>
                          <input type="range" min="0" max="1" step="0.05" value={volumeValue} onChange={(e) => changeUserVolume(member.socketId, e.target.value)} />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <aside className="right-activity-panel">
              {isHost && (
                <div className="panel request-only-panel glass-panel-next">
                  <div className="panel-title request-title">
                    <h3>Join Requests</h3>
                    <small>{requests.length} pending</small>
                  </div>
                  {requests.length === 0 && <p className="empty">No pending requests</p>}
                  {requests.map((request) => (
                    <div className="request" key={request.socketId}>
                      <span>{request.username}</span>
                      <div>
                        <button onClick={() => approveRequest(request)}>✓</button>
                        <button onClick={() => rejectRequest(request)}>✕</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="panel chat-panel glass-panel-next chat-panel-next">
                <div className="panel-title">
                  <h3>Squad Chat</h3>
                  <small>{chatMessages.length} msgs</small>
                </div>

                <div className="chat-box">
                  {chatMessages.length === 0 ? (
                    <p className="empty chat-empty">No messages yet</p>
                  ) : (
                    chatMessages.map((item) => (
                      <div className={`chat-message ${item.socketId === socket.id ? "own" : ""}`} key={item.id}>
                        <div className="chat-meta"><b>{item.username}</b><span>{item.time}</span></div>
                        <p>{item.text}</p>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>

                <div className="chat-input-row">
                  <input type="text" placeholder="Type a message..." value={chatText} onChange={(e) => setChatText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendChatMessage(); }} />
                  <button onClick={sendChatMessage}>Send</button>
                </div>
              </div>
            </aside>
          </main>

          <footer className="bottom-control-dock">
            <div className="call-controls-next">
              <button className={`control-btn ${!micOn ? "off" : "on"}`} data-tooltip={pushToTalkOn ? "PTT Mode Active" : micOn ? "Mute Mic" : "Turn On Mic"} onClick={toggleMic}>🎙️</button>
              <button className={`control-btn ${deafenOn ? "off" : ""}`} data-tooltip={deafenOn ? "Undeafen" : "Deafen"} onClick={toggleDeafen}>🎧</button>
              <button className={`control-btn ${cameraOn ? "on" : ""}`} data-tooltip={cameraOn ? "Stop Camera" : "Camera"} onClick={toggleCamera}>📷</button>
              <button className={`control-btn ${screenOn ? "on" : ""}`} data-tooltip={screenOn ? "Stop Screen" : "Share Screen"} onClick={toggleScreenShare}>🖥️</button>
              <button className="control-btn leave-btn" data-tooltip="Leave Call" onClick={leaveRoom}>📞</button>
            </div>

            <div className="ptt-settings ptt-dock-next">
              <div>
                <b>Push to Talk</b>
                <small>{pushToTalkOn ? `Hold "${pttKey.toUpperCase()}" to speak` : "Normal mic toggle mode"}</small>
              </div>
              <button className={pushToTalkOn ? "ptt-toggle active" : "ptt-toggle"} onClick={togglePushToTalk}>{pushToTalkOn ? "ON" : "OFF"}</button>
              <button className="ptt-key" onClick={() => { setIsSettingKey(true); setMessage("Press any key for Push-to-Talk."); }}>Key: {pttKey.toUpperCase()}</button>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}

export default App;
