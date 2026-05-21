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
    "dragon",
    "phoenix",
    "pegasus",
    "wolf",
    "leviathan",
    "lion",
    "raven",
    "deer",
    "shark",
    "scorpion",
  ];

  const getAnimalType = (index) => animalTypes[index % animalTypes.length];

  const getTileAccent = (index) => {
    const accents = ["blue", "orange", "green", "purple", "gold", "red", "violet", "cyan"];
    return accents[index % accents.length];
  };

  const AnimalLogo = ({ type = "dragon" }) => {
    const common = {
      viewBox: "0 0 128 128",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      className: `animal-svg animal-${type}`,
      "aria-hidden": "true",
    };

    const mark = (children) => (
      <svg {...common}>
        <g className="logo-mark">{children}</g>
      </svg>
    );

    if (type === "dragon") {
      return mark(
        <>
          <path className="logo-fill logo-soft" d="M22 78C28 48 49 27 77 17C68 30 69 42 82 49C69 47 54 52 42 65C34 73 28 78 22 78Z" />
          <path className="logo-fill" d="M19 79C39 45 72 28 111 32C100 39 94 48 94 58C105 61 114 69 121 82C104 78 88 82 75 92C55 106 35 99 19 79Z" />
          <path className="logo-fill" d="M47 61C51 44 64 32 86 20L79 44L99 36L87 58L47 61Z" />
          <path className="logo-fill logo-soft" d="M36 89C47 98 62 100 76 94C61 113 34 111 18 91C24 94 30 94 36 89Z" />
          <path className="logo-cut" d="M83 39L111 27L100 50L122 61L92 64L83 39Z" />
          <path className="logo-cut" d="M77 55L89 54L83 61L75 61L77 55Z" />
          <path className="logo-cut subtle-cut" d="M44 76C60 86 79 82 94 70C83 95 52 103 27 84L44 76Z" />
          <path className="logo-cut subtle-cut" d="M55 55C65 47 75 43 88 42C75 52 66 59 59 70L55 55Z" />
        </>
      );
    }

    if (type === "phoenix") {
      return mark(
        <>
          <path className="logo-fill logo-soft" d="M64 16C77 38 80 55 72 72C88 48 105 35 124 29C115 55 101 75 78 88C95 90 109 97 121 109C97 108 78 101 64 88C50 101 31 108 7 109C19 97 33 90 50 88C27 75 13 55 4 29C23 35 40 48 56 72C48 55 51 38 64 16Z" />
          <path className="logo-fill" d="M64 31C74 47 75 68 64 101C53 68 54 47 64 31Z" />
          <path className="logo-fill" d="M38 72C24 61 15 47 10 35C31 45 48 59 58 80L38 72Z" />
          <path className="logo-fill" d="M90 72C104 61 113 47 118 35C97 45 80 59 70 80L90 72Z" />
          <path className="logo-cut" d="M63 26L79 15L73 40L92 47L70 53L63 26Z" />
          <path className="logo-cut subtle-cut" d="M48 82C55 89 60 94 64 105C68 94 73 89 80 82C72 87 56 87 48 82Z" />
          <path className="logo-cut subtle-cut" d="M34 64C26 55 19 45 15 37C29 45 42 55 54 72L34 64Z" />
          <path className="logo-cut subtle-cut" d="M94 64C102 55 109 45 113 37C99 45 86 55 74 72L94 64Z" />
        </>
      );
    }

    if (type === "pegasus") {
      return mark(
        <>
          <path className="logo-fill logo-soft" d="M18 72C12 48 19 27 39 10C42 35 51 52 68 66C48 59 31 62 18 72Z" />
          <path className="logo-fill logo-soft" d="M34 58C38 35 49 19 67 6C65 36 72 55 91 71C68 60 50 57 34 58Z" />
          <path className="logo-fill" d="M23 84C39 47 72 31 112 42C96 49 87 59 83 74C95 75 105 82 114 94C92 91 75 95 60 103C43 112 30 104 23 84Z" />
          <path className="logo-fill" d="M60 62C72 49 89 47 111 58C96 62 85 70 78 83L60 62Z" />
          <path className="logo-fill logo-soft" d="M54 59L59 25L68 57L54 59Z" />
          <path className="logo-cut" d="M88 45L112 28L104 55L124 66L95 67L88 45Z" />
          <path className="logo-cut" d="M85 59L96 58L90 65L82 65L85 59Z" />
          <path className="logo-cut subtle-cut" d="M45 82C56 91 72 91 89 82C77 102 50 108 32 91L45 82Z" />
          <path className="logo-cut subtle-cut" d="M35 58C31 45 31 33 38 21C44 39 53 51 65 62L35 58Z" />
        </>
      );
    }

    if (type === "wolf") {
      return mark(
        <>
          <path className="logo-fill logo-soft" d="M33 48L42 18L57 44L33 48Z" />
          <path className="logo-fill logo-soft" d="M72 43L96 16L90 52L72 43Z" />
          <path className="logo-fill" d="M18 83C31 54 57 32 106 26C94 37 88 47 88 58C101 62 110 71 116 84C94 78 78 82 64 92C47 104 32 99 18 83Z" />
          <path className="logo-cut" d="M79 45L104 35L91 55L113 63L84 67L79 45Z" />
          <path className="logo-cut" d="M70 60L82 59L76 66L68 66L70 60Z" />
          <path className="logo-cut subtle-cut" d="M40 80C55 89 74 86 90 72C80 97 51 103 27 87L40 80Z" />
        </>
      );
    }

    if (type === "leviathan" || type === "shark" || type === "crocodile") {
      return mark(
        <>
          <path className="logo-fill logo-soft" d="M26 79C29 47 52 25 91 18C82 31 82 45 95 55C77 50 56 57 39 75L26 79Z" />
          <path className="logo-fill" d="M12 78C35 42 70 28 120 43C98 49 82 59 73 74C89 72 104 78 117 90C80 101 45 96 12 78Z" />
          <path className="logo-fill logo-soft" d="M38 79C48 98 71 102 96 92C76 118 38 113 19 90C26 91 32 88 38 79Z" />
          <path className="logo-cut" d="M84 43L116 32L101 56L124 68L88 68L84 43Z" />
          <path className="logo-cut" d="M78 58L91 57L84 65L75 64L78 58Z" />
          <path className="logo-cut subtle-cut" d="M40 78C57 87 82 84 102 72C82 97 50 101 24 84L40 78Z" />
        </>
      );
    }

    if (type === "lion") {
      return mark(
        <>
          <path className="logo-fill logo-soft" d="M63 12L79 28L103 24L97 48L116 65L92 74L82 100L64 85L45 101L36 74L12 65L31 48L25 24L49 28L63 12Z" />
          <path className="logo-fill" d="M36 68C45 42 78 34 99 54C87 55 77 62 68 73C57 88 43 90 26 78C31 76 34 72 36 68Z" />
          <path className="logo-cut" d="M72 44L100 34L84 57L108 66L76 68L72 44Z" />
          <path className="logo-cut subtle-cut" d="M40 80C56 90 77 86 92 69C84 96 52 105 28 88L40 80Z" />
        </>
      );
    }

    if (type === "raven") {
      return mark(
        <>
          <path className="logo-fill" d="M12 73C35 42 68 27 116 31C95 40 82 53 76 70C91 69 104 75 116 86C83 93 55 88 34 76C25 71 18 70 12 73Z" />
          <path className="logo-fill logo-soft" d="M44 77L35 113L64 88L94 113L85 77H44Z" />
          <path className="logo-cut" d="M80 40L107 28L93 50L116 59L85 64L80 40Z" />
          <path className="logo-cut subtle-cut" d="M39 73C55 81 73 79 91 68C76 92 48 96 22 80L39 73Z" />
        </>
      );
    }

    if (type === "deer") {
      return mark(
        <>
          <path className="logo-fill logo-soft" d="M39 42C26 27 26 14 34 6C42 24 52 32 64 37C76 32 86 24 94 6C102 14 102 27 89 42C77 35 51 35 39 42Z" />
          <path className="logo-fill" d="M64 35C82 35 94 49 90 68C86 88 64 108 64 108S42 88 38 68C34 49 46 35 64 35Z" />
          <path className="logo-cut" d="M47 60H82L64 92L47 60Z" />
          <path className="logo-cut subtle-cut" d="M51 42L35 25L56 35L51 42Z" />
          <path className="logo-cut subtle-cut" d="M77 42L93 25L72 35L77 42Z" />
        </>
      );
    }

    if (type === "scorpion") {
      return mark(
        <>
          <path className="logo-fill" d="M58 36C79 36 93 52 92 70C92 85 82 97 68 102C82 81 76 58 59 58C43 58 36 75 45 94C27 86 20 67 31 51C37 42 47 36 58 36Z" />
          <path className="logo-fill logo-soft" d="M78 27C101 12 119 27 110 49C103 36 92 34 80 43L78 27Z" />
          <path className="logo-fill logo-soft" d="M36 56L13 44L24 71L36 56Z" />
          <path className="logo-fill logo-soft" d="M84 56L116 52L99 76L84 56Z" />
          <path className="logo-cut" d="M70 37L94 23L85 48L70 37Z" />
        </>
      );
    }

    return mark(
      <>
        <path className="logo-fill logo-soft" d="M38 62C34 42 42 25 62 11C59 29 64 41 77 50C65 49 52 53 38 62Z" />
        <path className="logo-fill" d="M17 78C31 43 61 22 109 15C97 29 92 42 95 55C106 58 116 65 124 78C105 75 90 79 77 89C59 102 39 99 17 78Z" />
        <path className="logo-cut" d="M82 33L110 15L101 43L122 54L92 57L82 33Z" />
      </>
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
