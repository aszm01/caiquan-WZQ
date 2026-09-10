const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// 托管静态页面（wzq.html），让网页和游戏服务共用 8080 端口，部署时无需额外配置 nginx
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/wzq.html') {
        fs.readFile(path.join(__dirname, 'wzq.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('500 Internal Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

// 存储房间信息：key为房间ID，value为房间详情
const rooms = new Map();
// 存储房间列表（供客户端查看）
const roomList = new Map();
// 玩家类型
const PLAYER_TYPE = { PLAYER: 'player', SPECTATOR: 'spectator' };

wss.on('connection', (ws) => {
    console.log('新玩家连接');
    // 初始化玩家信息
    ws.id = Math.random().toString(36).slice(2, 10); // 生成唯一ID
    ws.username = '玩家' + Math.floor(Math.random() * 1000); // 默认用户名
    ws.hasSetUsername = false; // 是否已设置用户名
    ws.roomId = null; // 当前所在房间ID

    // 处理客户端消息
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            // 处理用户名设置
            if (message.type === 'setUsername' && message.username) {
                const validUsername = message.username.trim().slice(0, 10) || ws.username;
                ws.username = validUsername;
                ws.hasSetUsername = true;
                console.log(`玩家 ${ws.id} 设置用户名为：${ws.username}`);
                
                // 通知客户端用户名设置成功
                ws.send(JSON.stringify({
                    type: 'usernameSet',
                    success: true,
                    username: ws.username
                }));
                return;
            }

            // 处理创建房间
            if (message.type === 'createRoom') {
                if (!ws.hasSetUsername) return;
                
                // 创建房间
                const roomId = Math.random().toString(36).substr(2, 8);
                const roomName = `${ws.username}的房间`;
                
                rooms.set(roomId, {
                    id: roomId,
                    name: roomName,
                    players: [ws], // 对局者
                    spectators: [], // 观战者
                    roleMap: { [ws.id]: 0 }, // 创建者为0号角色（黑方）
                    playerTypeMap: { [ws.id]: PLAYER_TYPE.PLAYER }, // 玩家类型
                    moves: { 0: null, 1: null }, // 存储双方落子
                    restartRequests: { 0: false, 1: false }, // 重新开局请求
                    usernames: { 0: ws.username, 1: '' }, // 双方用户名
                    currentRound: 1, // 当前回合数
                    isPlayerFull: false, // 对局者是否满员
                    gameState: 'waiting', // 游戏状态: waiting, playing, ended
                    board: Array(15).fill().map(() => Array(15).fill({
                        player: -1,
                        type: -1,
                        visible: false
                    })),
                    forbidden: {},
                    winner: null
                });
                
                // 添加到房间列表
                roomList.set(roomId, {
                    id: roomId,
                    name: roomName,
                    playerCount: 1,
                    spectatorCount: 0,
                    isPlayerFull: false
                });
                
                ws.roomId = roomId;
                
                // 通知创建者房间创建成功
                ws.send(JSON.stringify({
                    type: 'roomCreated',
                    roomId,
                    roomName
                }));
                
                // 广播房间列表更新
                broadcastRoomList();
                console.log(`${ws.username} 创建了房间 ${roomName}(${roomId})`);
                return;
            }

            // 处理获取房间列表
            if (message.type === 'getRoomList') {
                // 返回所有房间，包括已满的
                const allRooms = Array.from(roomList.values());
                ws.send(JSON.stringify({
                    type: 'roomList',
                    rooms: allRooms
                }));
                return;
            }

            // 处理加入房间
            if (message.type === 'joinRoom' && message.roomId) {
                if (!ws.hasSetUsername) return;
                
                const room = rooms.get(message.roomId);
                if (!room) {
                    ws.send(JSON.stringify({
                        type: 'joinFailed',
                        message: '房间不存在'
                    }));
                    return;
                }
                
                // 判断是作为玩家还是观战者加入
                if (!room.isPlayerFull && message.joinAsPlayer !== false) {
                    // 作为玩家加入
                    room.players.push(ws);
                    room.roleMap[ws.id] = 1; // 加入者为1号角色（白方）
                    room.playerTypeMap[ws.id] = PLAYER_TYPE.PLAYER;
                    room.usernames[1] = ws.username;
                    room.isPlayerFull = true;
                    room.gameState = 'playing';
                    ws.roomId = message.roomId;
                    
                    // 更新房间列表
                    roomList.set(message.roomId, {
                        ...roomList.get(message.roomId),
                        playerCount: 2,
                        isPlayerFull: true
                    });
                    
                    // 通知房间内所有玩家匹配成功
                    room.players.forEach((player, idx) => {
                        if (player.readyState === WebSocket.OPEN) {
                            player.send(JSON.stringify({
                                type: 'matchSuccess',
                                role: idx,
                                roomId: room.id,
                                phase: 'select',
                                yourUsername: player.username,
                                opponentUsername: room.players[1 - idx].username,
                                playerType: PLAYER_TYPE.PLAYER
                            }));
                        }
                    });
                    
                    // 通知所有观战者游戏开始
                    room.spectators.forEach(spectator => {
                        if (spectator.readyState === WebSocket.OPEN) {
                            spectator.send(JSON.stringify({
                                type: 'gameStart',
                                roomId: room.id,
                                playerBlack: room.usernames[0],
                                playerWhite: room.usernames[1],
                                playerType: PLAYER_TYPE.SPECTATOR
                            }));
                        }
                    });
                    
                    console.log(`${ws.username} 作为玩家加入了房间 ${room.name}(${room.id})`);
                } else if (room.spectators.length < 2) {
                    // 作为观战者加入（最多2个观战者）
                    room.spectators.push(ws);
                    room.playerTypeMap[ws.id] = PLAYER_TYPE.SPECTATOR;
                    ws.roomId = message.roomId;
                    
                    // 更新房间列表
                    roomList.set(message.roomId, {
                        ...roomList.get(message.roomId),
                        spectatorCount: room.spectators.length
                    });
                    
                    // 通知观战者加入成功，发送当前实时游戏状态
                    ws.send(JSON.stringify({
                        type: 'spectatorJoined',
                        roomId: room.id,
                        roomName: room.name,
                        playerBlack: room.usernames[0],
                        playerWhite: room.usernames[1],
                        currentRound: room.currentRound,
                        gameState: room.gameState,
                        board: room.board,
                        forbidden: room.forbidden,
                        winner: room.winner,
                        // 发送当前回合的落子情况（如果有）
                        currentMoves: room.moves,
                        // 发送重新开局请求状态
                        restartRequests: room.restartRequests
                    }));
                    
                    console.log(`${ws.username} 作为观战者加入了房间 ${room.name}(${room.id})`);
                } else {
                    ws.send(JSON.stringify({
                        type: 'joinFailed',
                        message: '房间玩家已满，观战位置也已满'
                    }));
                    return;
                }
                
                // 广播房间列表更新
                broadcastRoomList();
                return;
            }

            // 处理退出房间 - 新增功能
            if (message.type === 'leaveRoom') {
                if (!ws.roomId) return;
                
                const room = rooms.get(ws.roomId);
                if (!room) {
                    ws.send(JSON.stringify({
                        type: 'leaveRoomResult',
                        success: false,
                        message: '房间不存在'
                    }));
                    return;
                }
                
                const playerType = room.playerTypeMap[ws.id];
                
                if (playerType === PLAYER_TYPE.PLAYER) {
                    // 对局者退出
                    // 通知房间内其他玩家
                    const otherPlayerIndex = room.players.findIndex(p => p.id === ws.id);
                    if (otherPlayerIndex !== -1) {
                        room.players.splice(otherPlayerIndex, 1);
                        
                        // 通知另一个对局者
                        if (room.players.length > 0) {
                            const otherPlayer = room.players[0];
                            if (otherPlayer.readyState === WebSocket.OPEN) {
                                otherPlayer.send(JSON.stringify({
                                    type: 'opponentLeave',
                                    message: `${ws.username} 已离开房间`
                                }));
                                otherPlayer.roomId = null;
                            }
                        }
                        
                        // 通知所有观战者
                        room.spectators.forEach(spectator => {
                            if (spectator.readyState === WebSocket.OPEN) {
                                spectator.send(JSON.stringify({
                                    type: 'playerLeft',
                                    message: `${ws.username} 已离开房间，游戏结束`
                                }));
                                spectator.roomId = null;
                            }
                        });
                        
                        // 从房间列表移除
                        rooms.delete(ws.roomId);
                        roomList.delete(ws.roomId);
                        console.log(`房间 ${ws.roomId} 已解散（对局者离开）`);
                    }
                } else if (playerType === PLAYER_TYPE.SPECTATOR) {
                    // 观战者退出
                    const spectatorIndex = room.spectators.findIndex(s => s.id === ws.id);
                    if (spectatorIndex !== -1) {
                        room.spectators.splice(spectatorIndex, 1);
                        
                        // 更新房间列表
                        roomList.set(ws.roomId, {
                            ...roomList.get(ws.roomId),
                            spectatorCount: room.spectators.length
                        });
                        
                        console.log(`${ws.username} 作为观战者离开了房间 ${room.name}(${room.id})`);
                    }
                }
                
                // 通知房间内其他玩家
                if (playerType === PLAYER_TYPE.PLAYER) {
                    const otherPlayer = room.players.find(p => p.id !== ws.id);
                    if (otherPlayer && otherPlayer.readyState === WebSocket.OPEN) {
                        otherPlayer.send(JSON.stringify({
                            type: 'opponentLeave',
                            message: `${ws.username} 已离开房间`
                        }));
                        otherPlayer.roomId = null;
                    }
                    
                    // 通知所有观战者
                    room.spectators.forEach(spectator => {
                        if (spectator.readyState === WebSocket.OPEN) {
                            spectator.send(JSON.stringify({
                                type: 'playerLeft',
                                message: `${ws.username} 已离开房间，游戏结束`
                            }));
                            spectator.roomId = null;
                        }
                    });
                    
                    // 从房间列表移除
                    rooms.delete(ws.roomId);
                    roomList.delete(ws.roomId);
                    console.log(`房间 ${ws.roomId} 已解散（对局者离开）`);
                }
                
                // 重置玩家房间信息
                ws.roomId = null;
                
                // 通知客户端退出成功
                ws.send(JSON.stringify({
                    type: 'leaveRoomResult',
                    success: true
                }));
                
                // 广播房间列表更新
                broadcastRoomList();
                return;
            }

            // 处理游戏内消息（落子、重新开局）
            if (!ws.roomId) return; // 不在房间内则忽略
            
            const room = rooms.get(ws.roomId);
            if (!room) return; // 房间不存在则忽略
            
            const currentRole = room.roleMap[ws.id];
            if (currentRole === undefined) return;

            // 处理落子
            if (message.type === 'submitMove') {
                const move = message.data;
                if (move && typeof move.row === 'number' && typeof move.col === 'number' && typeof move.type === 'number') {
                    room.moves[currentRole] = move;
                    console.log(`${ws.roomId} ${room.usernames[currentRole]} 提交落子:`, move);

                    ws.send(JSON.stringify({ type: 'moveSubmitted', success: true }));

                    // 双方都落子后结算
                    if (room.moves[0] !== null && room.moves[1] !== null) {
                        // 保存当前棋盘状态用于观战者
                        const black = room.moves[0];
                        const white = room.moves[1];
                        room.board[black.row][black.col] = {
                            player: 0,
                            type: black.type,
                            visible: false
                        };
                        room.board[white.row][white.col] = {
                            player: 1,
                            type: white.type,
                            visible: false
                        };

                        // 结算回合结果
                        const samePosition = (black.row === white.row) && (black.col === white.col);
                        let eventType = null;
                        
                        if (samePosition) {
                            if (black.type === white.type) {
                                // 记录为下回合禁用
                                room.forbidden[`${black.row},${black.col}`] = room.currentRound + 1;
                                room.board[black.row][black.col] = {
                                    player: -1, 
                                    type: -1, 
                                    visible: false
                                };
                                eventType = 'stillWater'; // 静如止水
                            } else if (
                                (black.type === 1 && white.type === 0) || // 石头胜剪刀
                                (black.type === 0 && white.type === 2) || // 剪刀胜布
                                (black.type === 2 && white.type === 1)    // 布胜石头
                            ) {
                                room.board[black.row][black.col] = {
                                    player: 0,
                                    type: black.type,
                                    visible: true
                                };
                                eventType = 'flyingSand'; // 飞沙走石
                            } else {
                                room.board[white.row][white.col] = {
                                    player: 1,
                                    type: white.type,
                                    visible: true
                                };
                                eventType = 'flyingSand'; // 飞沙走石
                            }
                        } else {
                            room.board[black.row][black.col].visible = true;
                            room.board[white.row][white.col].visible = true;
                        }

                        // 通知所有玩家结算
                        room.players.forEach((player, idx) => {
                            if (player.readyState === WebSocket.OPEN) {
                                player.send(JSON.stringify({
                                    type: 'startSettle',
                                    allMoves: [room.moves[0], room.moves[1]],
                                    yourRole: idx,
                                    currentRound: room.currentRound
                                }));
                            }
                        });

                        // 通知所有观战者结算结果
                        room.spectators.forEach(spectator => {
                            if (spectator.readyState === WebSocket.OPEN) {
                                spectator.send(JSON.stringify({
                                    type: 'spectatorSettle',
                                    allMoves: [room.moves[0], room.moves[1]],
                                    board: room.board,
                                    forbidden: room.forbidden,
                                    currentRound: room.currentRound,
                                    eventType: eventType // 添加事件类型
                                }));
                            }
                        });

                        room.currentRound++;
                        room.moves = { 0: null, 1: null }; // 重置落子记录
                    }
                }
            }

            // 处理重新开局请求
            if (message.type === 'requestRestart') {
                room.restartRequests[currentRole] = true;
                console.log(`房间 ${ws.roomId} ${room.usernames[currentRole]} 请求重新开局`);

                // 通知双方当前请求状态
                room.players.forEach((player, idx) => {
                    if (player.readyState === WebSocket.OPEN) {
                        player.send(JSON.stringify({
                            type: 'restartStatus',
                            requests: { ...room.restartRequests },
                            yourRole: idx
                        }));
                    }
                });

                // 双方都同意则重新开局
                if (room.restartRequests[0] && room.restartRequests[1]) {
                    // 重置棋盘和游戏状态
                    room.board = Array(15).fill().map(() => Array(15).fill({
                        player: -1,
                        type: -1,
                        visible: false
                    }));
                    room.forbidden = {};
                    room.winner = null;
                    
                    // 通知所有玩家重新开局
                    room.players.forEach((player) => {
                        if (player.readyState === WebSocket.OPEN) {
                            player.send(JSON.stringify({ type: 'restartGame' }));
                        }
                    });
                    
                    // 通知所有观战者重新开局
                    room.spectators.forEach(spectator => {
                        if (spectator.readyState === WebSocket.OPEN) {
                            spectator.send(JSON.stringify({
                                type: 'gameStart',
                                roomId: room.id,
                                playerBlack: room.usernames[0],
                                playerWhite: room.usernames[1],
                                playerType: PLAYER_TYPE.SPECTATOR,
                                eventType: 'mightyForce' // 添加"力拔山兮"事件
                            }));
                        }
                    });
                    
                    room.restartRequests = { 0: false, 1: false };
                    room.currentRound = 1;
                }
            }

        } catch (error) {
            console.error('消息处理错误:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: '消息处理失败'
            }));
        }
    });

    // 断开连接处理
    ws.on('close', () => {
        console.log(`玩家 ${ws.username}(${ws.id}) 断开连接`);
        
        if (ws.roomId) {
            const room = rooms.get(ws.roomId);
            if (room) {
                // 检查断开连接的是玩家还是观战者
                const playerIndex = room.players.findIndex(p => p.id === ws.id);
                const spectatorIndex = room.spectators.findIndex(s => s.id === ws.id);
                
                if (playerIndex !== -1) {
                    // 对局者断开连接
                    // 通知房间内其他玩家
                    const otherPlayer = room.players.find(p => p.id !== ws.id);
                    if (otherPlayer && otherPlayer.readyState === WebSocket.OPEN) {
                        otherPlayer.send(JSON.stringify({
                            type: 'opponentLeave',
                            message: `${ws.username} 已离开`
                        }));
                        otherPlayer.roomId = null;
                    }
                    
                    // 通知所有观战者
                    room.spectators.forEach(spectator => {
                        if (spectator.readyState === WebSocket.OPEN) {
                            spectator.send(JSON.stringify({
                                type: 'playerLeft',
                                message: `${ws.username} 已离开房间，游戏结束`
                            }));
                            spectator.roomId = null;
                        }
                    });
                    
                    // 从房间列表移除
                    rooms.delete(ws.roomId);
                    roomList.delete(ws.roomId);
                    console.log(`房间 ${ws.roomId} 已解散（对局者离开）`);
                } else if (spectatorIndex !== -1) {
                    // 观战者断开连接
                    room.spectators.splice(spectatorIndex, 1);
                    
                    // 更新房间列表
                    roomList.set(ws.roomId, {
                        ...roomList.get(ws.roomId),
                        spectatorCount: room.spectators.length
                    });
                    
                    console.log(`${ws.username} 作为观战者断开了房间 ${room.name}(${room.id}) 的连接`);
                }
                
                // 广播房间列表更新
                broadcastRoomList();
            }
        }
    });

    // 连接错误处理
    ws.onerror = (error) => {
        console.error(`玩家 ${ws.id} 连接错误:`, error);
    };
});

// 广播房间列表给所有在线客户端
function broadcastRoomList() {
    const roomListData = Array.from(roomList.values());
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'roomList',
                rooms: roomListData
            }));
        }
    });
}

server.listen(8080, () => {
    console.log('服务器启动成功，请访问：http://localhost:8080');
});