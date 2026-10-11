// ==================================================
// ShieldHub Voice + Screen Share (WebRTC) - CLIENT SIDE
// ==================================================

(function() {
    'use strict';

    const socket = io();
    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ]
    };

    let localStream = null;
    let screenStream = null;
    let peerConnections = {};
    let screenConnections = {};
    let currentChannelId = null;
    let currentChannelType = 'text';
    let currentReadOnly = false;
    let currentCanChat = true;
    let isSharing = false;
    let myUsername = window.ME;
    let myServerId = window.SERVER_ID;

    // 🔥 FALLBACK: If window.ME is undefined, get username from sidebar
    if (!myUsername || myUsername === 'undefined' || myUsername === undefined) {
        const nameEl = document.querySelector('.user-name');
        if (nameEl) myUsername = nameEl.textContent.trim();
        else myUsername = 'User-' + Math.floor(Math.random() * 1000);
        console.log('⚠️ window.ME was undefined, using fallback:', myUsername);
    }
    console.log('🎤 Voice setup: user =', myUsername, '| serverId =', myServerId);

    let audioContext = null;
    let analyser = null;
    let voiceParticipants = [];

    // ==================================================
    // FULLSCREEN HELPERS
    // ==================================================
    function enterFullscreen(el) {
        if (!el) return;
        try {
            if (el.requestFullscreen) el.requestFullscreen().catch(e => console.warn('FS blocked:', e));
            else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
            else if (el.msRequestFullscreen) el.msRequestFullscreen();
        } catch(e) { console.warn('Fullscreen failed:', e); }
    }
    function exitFullscreen() {
        try {
            if (document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) {
                if (document.exitFullscreen) document.exitFullscreen().catch(e=>{});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                else if (document.msExitFullscreen) document.msExitFullscreen();
            }
        } catch(e) {}
    }

    // ==================================================
    // SWITCH CHANNEL
    // ==================================================
    window.switchChannel = async function(id, name, type, readOnly, canChat) {
        currentChannelId = id;
        currentChannelType = type;
        currentReadOnly = !!readOnly;
        if (type === 'voice') {
            currentCanChat = !!canChat;
        } else {
            currentCanChat = !readOnly;
        }

        document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('active'));
        const el = document.querySelector('.channel-item[data-channel-id="' + id + '"]');
        if (el) el.classList.add('active');

        document.getElementById('currentChannelName').textContent = name;
        document.getElementById('currentChannelIcon').textContent = type === 'voice' ? '🔊' : (readOnly ? '🔒' : '#');

        document.getElementById('textView').style.display = 'none';
        document.getElementById('voiceView').style.display = 'none';

        if (type === 'voice') {
            document.getElementById('voiceView').style.display = 'flex';
            document.getElementById('voiceChannelName').textContent = name;
            if (localStream && window._currentVoiceChannel === id) {
                document.getElementById('joinVoiceBtn').textContent = 'Connected';
                document.getElementById('joinVoiceBtn').disabled = true;
            } else {
                document.getElementById('joinVoiceBtn').textContent = 'Join Voice';
                document.getElementById('joinVoiceBtn').disabled = false;
            }

            const voiceChatMessages = document.getElementById('voiceChatMessages');
            const existingInput = document.getElementById('voiceChatInputArea');
            if (currentCanChat) {
                if (!existingInput) {
                    const inputArea = document.createElement('div');
                    inputArea.id = 'voiceChatInputArea';
                    inputArea.className = 'chat-input-area';
                    inputArea.style.marginTop = '12px';
                    inputArea.innerHTML = '<form onsubmit="event.preventDefault();sendVoiceMessage();"><input type="text" id="voiceChatInput" placeholder="Message in voice channel (creator/owner/admin only)..." maxlength="500"><button type="submit" class="btn btn-primary">Send</button></form>';
                    voiceChatMessages.parentNode.insertBefore(inputArea, voiceChatMessages);
                }
                socket.emit('join-channel', id);
                try {
                    const r = await fetch('/api/channels/' + id + '/messages');
                    const msgs = await r.json();
                    renderVoiceMessages(msgs);
                } catch(e) {}
            } else {
                if (existingInput) existingInput.remove();
                const vcm = document.getElementById('voiceChatMessages');
                if (vcm) vcm.innerHTML = '';
            }
            renderVoiceParticipants();
        } else {
            document.getElementById('textView').style.display = 'flex';
            document.getElementById('chatInput').disabled = !currentCanChat;
            document.getElementById('sendBtn').disabled = !currentCanChat;
            document.getElementById('chatInput').placeholder = currentCanChat ? 'Message...' : 'Read-only (only creator/owner/admin can chat)';
            document.getElementById('chatMessages').innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px;">Loading...</div>';
            try {
                const r = await fetch('/api/channels/' + id + '/messages');
                const msgs = await r.json();
                renderMessages(msgs);
            } catch(e) { console.error(e); }
            socket.emit('join-channel', id);
        }
    };

    // ==================================================
    // TEXT CHAT
    // ==================================================
    function renderMessages(msgs) {
        const box = document.getElementById('chatMessages');
        if (msgs.length === 0) {
            box.innerHTML = '<div style="text-align:center;color:var(--text3);padding:40px;">No messages yet</div>';
            return;
        }
        box.innerHTML = '';
        msgs.forEach(function(m) {
            const isA = m.role === 'ADMIN';
            const av = isA ? 'linear-gradient(135deg,#ffaa00,#ff6600)' : 'linear-gradient(135deg,var(--red),var(--red2))';
            const div = document.createElement('div');
            div.className = 'chat-message';
            div.innerHTML = '<div class="msg-avatar" style="background:' + av + '">' + m.username[0].toUpperCase() + '</div>' +
                '<div class="msg-body"><div class="msg-meta"><span class="msg-username">' + m.username + '</span>' +
                (isA ? '<span class="badge badge-admin">Admin</span>' : '') +
                '<span class="msg-time">' + m.created_at + '</span></div>' +
                '<div class="msg-content">' + escapeHtml(m.message) + '</div></div>';
            box.appendChild(div);
        });
        box.scrollTop = box.scrollHeight;
    }

    function renderVoiceMessages(msgs) {
        const box = document.getElementById('voiceChatMessages');
        if (!box) return;
        if (msgs.length === 0) {
            box.innerHTML = '<div style="text-align:center;color:var(--text3);padding:12px;font-size:12px;">No messages yet</div>';
            return;
        }
        box.innerHTML = '';
        msgs.forEach(function(m) {
            const div = document.createElement('div');
            div.style.cssText = 'display:flex;gap:8px;padding:8px 12px;background:rgba(22,11,11,0.5);border-radius:10px;font-size:13px;margin-bottom:6px;';
            div.innerHTML = '<strong style="color:#ff5555;">' + m.username + ':</strong> <span style="color:var(--text1);">' + escapeHtml(m.message) + '</span>';
            box.appendChild(div);
        });
        box.scrollTop = box.scrollHeight;
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    window.sendMessage = async function() {
        if (!currentChannelId || currentChannelType === 'voice' || !currentCanChat) return;
        const input = document.getElementById('chatInput');
        const msg = input.value.trim();
        if (!msg) return;
        input.value = '';
        try {
            const r = await fetch('/api/channels/' + currentChannelId + '/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
            });
            const d = await r.json();
            if (d.error) { alert(d.error); return; }
            const r2 = await fetch('/api/channels/' + currentChannelId + '/messages');
            const msgs = await r2.json();
            renderMessages(msgs);
        } catch(e) { console.error(e); }
    };

    window.sendVoiceMessage = async function() {
        if (!currentChannelId || !currentCanChat) return;
        const input = document.getElementById('voiceChatInput');
        if (!input) return;
        const msg = input.value.trim();
        if (!msg) return;
        input.value = '';
        try {
            const r = await fetch('/api/channels/' + currentChannelId + '/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
            });
            const d = await r.json();
            if (d.error) { alert(d.error); return; }
            const r2 = await fetch('/api/channels/' + currentChannelId + '/messages');
            const msgs = await r2.json();
            renderVoiceMessages(msgs);
        } catch(e) { console.error(e); }
    };

    // ==================================================
    // CREATE / DELETE CHANNEL
    // ==================================================
    window.openCreateChannel = function(isVoice) {
        document.getElementById('createChannelModal').style.display = 'flex';
        if (isVoice) document.getElementById('newChannelType').value = 'voice';
    };

    window.createChannel = async function() {
        const n = document.getElementById('newChannelName').value.trim();
        const t = document.getElementById('newChannelType').value;
        if (!n) return alert('Name required');
        try {
            const r = await fetch('/api/servers/' + myServerId + '/channels', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: n, type: t })
            });
            const d = await r.json();
            if (d.id) location.reload();
            else alert(d.error || 'Error');
        } catch(e) { alert('Error: ' + e.message); }
    };

    window.deleteChannel = async function(id) {
        if (!confirm('Delete this channel?')) return;
        try {
            const r = await fetch('/api/channels/' + id + '/delete', { method: 'POST' });
            const d = await r.json();
            if (d.success) {
                const el = document.querySelector('.channel-item[data-channel-id="' + id + '"]');
                if (el) el.remove();
            } else alert(d.error || 'Error');
        } catch(e) { alert('Error: ' + e.message); }
    };

    // ==================================================
    // KICK USER
    // ==================================================
    window.kickUser = async function(username) {
        if (!confirm('Kick ' + username + ' from this server?')) return;
        try {
            const r = await fetch('/api/servers/' + myServerId + '/kick', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username })
            });
            const d = await r.json();
            if (d.success) location.reload();
            else alert(d.error || 'Error');
        } catch(e) { alert('Error: ' + e.message); }
    };

    // ==================================================
    // VOICE: JOIN / LEAVE
    // ==================================================
    window.joinVoice = async function() {
        if (localStream) return;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });
            window._currentVoiceChannel = currentChannelId;
            document.getElementById('voicePanel').style.display = 'block';
            document.getElementById('voiceChannelName').textContent = document.getElementById('currentChannelName').textContent;
            document.getElementById('joinVoiceBtn').textContent = 'Connected';
            document.getElementById('joinVoiceBtn').disabled = true;
            socket.emit('voice-join', { serverId: myServerId, channelId: currentChannelId, username: myUsername });
            setupSpeakingDetection();
        } catch(e) {
            alert('Microphone access denied: ' + e.message);
        }
    };

    window.leaveVoice = function() {
        Object.values(peerConnections).forEach(pc => { try { pc.close(); } catch(e){} });
        Object.values(screenConnections).forEach(pc => { try { pc.close(); } catch(e){} });
        peerConnections = {};
        screenConnections = {};
        if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
        if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
        socket.emit('voice-leave', { serverId: myServerId, channelId: currentChannelId, username: myUsername });
        document.getElementById('voicePanel').style.display = 'none';
        document.getElementById('voiceUsers').innerHTML = '';
        const btn = document.getElementById('joinVoiceBtn');
        if (btn) { btn.textContent = 'Join Voice'; btn.disabled = false; }
        document.getElementById('remoteAudios').innerHTML = '';
        window._currentVoiceChannel = null;
        isSharing = false;
    };

    // ==================================================
    // VOICE: MUTE
    // ==================================================
    window.toggleMute = function() {
        if (!localStream) return;
        const track = localStream.getAudioTracks()[0];
        track.enabled = !track.enabled;
        document.getElementById('muteBtn').textContent = track.enabled ? 'Mute' : 'Unmute';
    };

    // ==================================================
    // VOICE: PEER CONNECTION
    // ==================================================
    function createPeerConnection(username) {
        if (peerConnections[username]) {
            try { peerConnections[username].close(); } catch(e){}
        }
        const pc = new RTCPeerConnection(ICE_CONFIG);
        peerConnections[username] = pc;
        if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        pc.ontrack = function(event) {
            const remoteStream = event.streams[0];
            let audioEl = document.getElementById('audio-' + username);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = 'audio-' + username;
                audioEl.autoplay = true;
                audioEl.playsInline = true;
                document.getElementById('remoteAudios').appendChild(audioEl);
            }
            audioEl.srcObject = remoteStream;
            audioEl.play().catch(e => console.warn('Autoplay blocked:', e));
        };
        pc.onicecandidate = function(event) {
            if (event.candidate) socket.emit('voice-ice', { to: username, candidate: event.candidate });
        };
        return pc;
    }

    // ==================================================
    // VOICE: SOCKET EVENTS
    // ==================================================
    socket.on('voice-user-list', async function(users) {
        for (const username of users) {
            if (username === myUsername) continue;
            const pc = createPeerConnection(username);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('voice-offer', { to: username, offer: offer });
        }
    });

    socket.on('voice-offer', async function(data) {
        const pc = createPeerConnection(data.username);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice-answer', { to: data.from, answer: answer });
    });

    socket.on('voice-answer', async function(data) {
        const pc = peerConnections[data.from];
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    });

    socket.on('voice-ice', async function(data) {
        const pc = peerConnections[data.from];
        if (pc && data.candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e) {}
        }
    });

    socket.on('voice-user-left', function(data) {
        if (peerConnections[data.username]) {
            try { peerConnections[data.username].close(); } catch(e){}
            delete peerConnections[data.username];
        }
        const audioEl = document.getElementById('audio-' + data.username);
        if (audioEl) audioEl.remove();
    });

    socket.on('voice-participants', function(list) {
        voiceParticipants = list;
        renderVoiceParticipants();
    });

    // ==================================================
    // VOICE PARTICIPANTS RENDER
    // ==================================================
    function renderVoiceParticipants() {
        const box = document.getElementById('voiceUsers');
        if (!box) return;
        if (voiceParticipants.length === 0) {
            box.innerHTML = '<div style="text-align:center;color:var(--text3);padding:20px;font-size:13px;">No one is in this voice channel</div>';
            return;
        }
        box.innerHTML = '';
        voiceParticipants.forEach(function(username) {
            const isMe = username === myUsername;
            const div = document.createElement('div');
            div.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;background:rgba(22,11,11,0.6);border:1px solid var(--border);border-radius:12px;margin-bottom:8px;';
            div.innerHTML = 
                '<div id="ring-' + username + '" style="position:relative;width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,var(--red),var(--red2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:20px;flex-shrink:0;">' +
                    username[0].toUpperCase() +
                '</div>' +
                '<div style="flex:1;">' +
                    '<div style="font-weight:700;font-size:14px;">' + username + (isMe ? ' (you)' : '') + '</div>' +
                    '<div style="font-size:11px;color:#4ade80;">● Speaking</div>' +
                '</div>' +
                '<button class="btn btn-primary btn-xs" onclick="event.stopPropagation();viewUserScreen(\'' + username + '\')">View Screen</button>';
            box.appendChild(div);
        });
    }

    // ==================================================
    // SCREEN SHARE
    // ==================================================
    window.toggleScreenShare = async function() {
        if (isSharing) { stopScreenShare(); return; }
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
            isSharing = true;
            document.getElementById('shareBtn').textContent = 'Stop Sharing';
            document.getElementById('shareBtn').className = 'btn btn-danger btn-xs';
            socket.emit('screen-share-start', { serverId: myServerId, channelId: currentChannelId, username: myUsername });
            screenStream.getVideoTracks()[0].onended = function() { stopScreenShare(); };
            document.getElementById('screenVideo').srcObject = screenStream;
            document.getElementById('sharingUser').textContent = 'You (your screen)';
            const overlay = document.getElementById('screenShareOverlay');
            overlay.style.display = 'flex';
            document.body.classList.add('screenshare-lock');
            setTimeout(() => enterFullscreen(overlay), 100);
            for (const username of voiceParticipants) {
                if (username === myUsername) continue;
                const pc = new RTCPeerConnection(ICE_CONFIG);
                screenConnections[username] = pc;
                screenStream.getTracks().forEach(track => pc.addTrack(track, screenStream));
                pc.onicecandidate = function(event) {
                    if (event.candidate) socket.emit('screen-ice', { to: username, candidate: event.candidate });
                };
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('screen-offer', { to: username, offer: offer });
            }
        } catch(e) { console.warn('Screen share cancelled:', e.message); }
    };

    window.stopScreenShare = function() {
        if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
        isSharing = false;
        document.getElementById('shareBtn').textContent = 'Share Screen';
        document.getElementById('shareBtn').className = 'btn btn-secondary btn-xs';
        document.getElementById('screenShareOverlay').style.display = 'none';
        document.body.classList.remove('screenshare-lock');
        exitFullscreen();
        socket.emit('screen-share-stop', { serverId: myServerId, channelId: currentChannelId, username: myUsername });
    };

    socket.on('screen-share-start', function(data) {
        if (data.username === myUsername) return;
        setTimeout(() => { connectToScreenShare(data.username, data.from); }, 300);
    });

    socket.on('screen-share-stop', function(data) {
        if (data.username === myUsername) return;
        if (screenConnections[data.username]) {
            try { screenConnections[data.username].close(); } catch(e){}
            delete screenConnections[data.username];
        }
        const overlay = document.getElementById('screenShareOverlay');
        if (overlay.style.display === 'flex' && document.getElementById('sharingUser').textContent === data.username) {
            overlay.style.display = 'none';
            document.body.classList.remove('screenshare-lock');
            exitFullscreen();
        }
    });

    async function connectToScreenShare(username, socketId) {
        const pc = new RTCPeerConnection(ICE_CONFIG);
        screenConnections[username] = pc;
        pc.ontrack = function(event) {
            const videoEl = document.getElementById('screenVideo');
            videoEl.srcObject = event.streams[0];
            videoEl.play().catch(e => console.warn(e));
            document.getElementById('sharingUser').textContent = username;
            const overlay = document.getElementById('screenShareOverlay');
            overlay.style.display = 'flex';
            document.body.classList.add('screenshare-lock');
            setTimeout(() => enterFullscreen(overlay), 100);
        };
        pc.onicecandidate = function(event) {
            if (event.candidate) socket.emit('screen-ice', { to: socketId, candidate: event.candidate });
        };
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    socket.on('screen-offer', async function(data) {
        const pc = new RTCPeerConnection(ICE_CONFIG);
        screenConnections[data.username] = pc;
        pc.ontrack = function(event) {
            const videoEl = document.getElementById('screenVideo');
            videoEl.srcObject = event.streams[0];
            videoEl.play().catch(e => console.warn(e));
            document.getElementById('sharingUser').textContent = data.username;
            const overlay = document.getElementById('screenShareOverlay');
            overlay.style.display = 'flex';
            document.body.classList.add('screenshare-lock');
            setTimeout(() => enterFullscreen(overlay), 100);
        };
        pc.onicecandidate = function(event) {
            if (event.candidate) socket.emit('screen-ice', { to: data.from, candidate: event.candidate });
        };
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('screen-answer', { to: data.from, answer: answer });
    });

    socket.on('screen-answer', async function(data) {
        const pc = screenConnections[data.from];
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    });

    socket.on('screen-ice', async function(data) {
        const pc = screenConnections[data.from] || peerConnections[data.from];
        if (pc && data.candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e) {}
        }
    });

    // ==================================================
    // VIEW SCREEN
    // ==================================================
    window.viewUserScreen = function(username) {
        if (username === myUsername) {
            if (screenStream) {
                document.getElementById('screenVideo').srcObject = screenStream;
                document.getElementById('sharingUser').textContent = 'You (your screen)';
                const overlay = document.getElementById('screenShareOverlay');
                overlay.style.display = 'flex';
                document.body.classList.add('screenshare-lock');
                setTimeout(() => enterFullscreen(overlay), 100);
            } else {
                alert('You are not sharing your screen right now.');
            }
            return;
        }
        if (screenConnections[username]) {
            document.getElementById('sharingUser').textContent = username;
            const overlay = document.getElementById('screenShareOverlay');
            overlay.style.display = 'flex';
            document.body.classList.add('screenshare-lock');
            setTimeout(() => enterFullscreen(overlay), 100);
        } else {
            alert(username + ' is not sharing their screen right now.');
        }
    };

    window.closeScreenView = function() {
        document.getElementById('screenShareOverlay').style.display = 'none';
        document.body.classList.remove('screenshare-lock');
        exitFullscreen();
    };

    window.toggleFullscreen = function() {
        const overlay = document.getElementById('screenShareOverlay');
        const video = document.getElementById('screenVideo');
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            enterFullscreen(video || overlay);
        } else {
            exitFullscreen();
        }
    };

    // ==================================================
    // SPEAKING DETECTION
    // ==================================================
    function setupSpeakingDetection() {
        if (!localStream) return;
        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioContext.createMediaStreamSource(localStream);
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            function checkVolume() {
                if (!analyser) return;
                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                const avg = sum / dataArray.length;
                const ring = document.getElementById('ring-' + myUsername);
                if (ring) ring.style.boxShadow = avg > 20 ? '0 0 0 3px #22c55e' : 'none';
                requestAnimationFrame(checkVolume);
            }
            checkVolume();
        } catch(e) { console.warn('Speaking detection error:', e); }
    }

    // ==================================================
    // KICK NOTIFICATION
    // ==================================================
    socket.on('user-kicked', function(data) {
        if (data.username === myUsername) {
            alert('You have been kicked from this server.');
            window.location.href = '/servers';
        }
    });

    // ==================================================
    // CHAT MESSAGE AUTO-REFRESH
    // ==================================================
    socket.on('chat-message', function(data) {
        if (currentChannelId && data.channelId === currentChannelId) {
            if (currentChannelType === 'voice') {
                fetch('/api/channels/' + currentChannelId + '/messages')
                    .then(r => r.json())
                    .then(msgs => renderVoiceMessages(msgs));
            } else {
                fetch('/api/channels/' + currentChannelId + '/messages')
                    .then(r => r.json())
                    .then(msgs => renderMessages(msgs));
            }
        }
    });

    console.log('✅ ShieldHub Voice loaded for', myUsername);
})();
