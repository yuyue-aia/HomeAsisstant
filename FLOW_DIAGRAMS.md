# Flow Diagrams - Visual Execution Paths

## 1. Two-Pass Inference Pattern (Complete Timeline)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TOTAL LATENCY: ~2-3 seconds                         │
└─────────────────────────────────────────────────────────────────────────────┘

0. User Input (Voice)
   ├─ "开客厅空调到二十六度" (Open living room AC to 26 degrees)
   │
   ├─ ASR Processing (~300-500ms)
   │  └─ Tencent Cloud: speech → text
   │
   └─ Text Input: "开客厅空调到二十六度"

1. PASS 1: LIGHTWEIGHT SKILL SELECTION (~800ms)
   ├─ OpenAIAgentRuntime.run() called
   ├─ Load today's history from .runtime/agent-history/2026-05-29.json
   ├─ Build context:
   │  ├─ BASE_INSTRUCTIONS (output format, tool usage rules)
   │  └─ 【可用技能】 section:
   │     ├─ 1. game: 处理小朋友想玩游戏机...
   │     ├─ 2. air-conditioner: 控制五个房间的空调...
   │     ├─ 3. reminder: 设置、修改、删除定时提醒
   │     └─ 4. music: 搜索音乐库并播放
   │
   ├─ Create turnInput:
   │  └─ [...previousHistory, { role: 'user', content: '开客厅空调到二十六度' }]
   │
   ├─ OpenAI API Call #1 (Skill Selection)
   │  ├─ Input tokens: ~100
   │  │  ├─ system: BASE_INSTRUCTIONS + skill list (~8 tokens)
   │  │  └─ user: "开客厅空调到二十六度"
   │  │
   │  ├─ LLM Processing: "User wants AC control → need air-conditioner skill"
   │  │
   │  ├─ Output tokens: ~20
   │  │  ├─ Tool call: {
   │  │  │    "name": "load_skill",
   │  │  │    "arguments": { "name": "air-conditioner" }
   │  │  │  }
   │  │
   │  ├─ Network time: ~200ms each way (request + response)
   │  └─ Inference time: ~400ms
   │
   └─ Latency breakdown for PASS 1:
      ├─ Network upload: ~200ms (send tokens to OpenAI)
      ├─ OpenAI inference: ~400ms (GPT-4o processing)
      └─ Network download: ~200ms (receive tool call)

2. LOAD SKILL TOOL EXECUTION (~50ms)
   ├─ Tool: load_skill(name: "air-conditioner")
   ├─ Action: Read skills/air-conditioner/SKILL.md from disk
   ├─ Parse: Extract full body content (35 lines, ~260 tokens)
   ├─ Return to agent loop:
   │  └─ {
   │       "ok": true,
   │       "name": "air-conditioner",
   │       "directory": "skills/air-conditioner",
   │       "instructions": "[Full SKILL.md content - 35 lines]"
   │     }
   │
   └─ Agent history updated:
      ├─ ...(previous turns)
      ├─ { role: 'user', content: '开客厅空调到二十六度' }
      ├─ { role: 'assistant', content: 'tool_call', tool_name: 'load_skill' }
      └─ { role: 'tool', tool_name: 'load_skill', content: '[instructions]' }

3. PASS 2: HEAVY EXECUTION (~800ms)
   ├─ OpenAI API Call #2 (Execution with Full Rules)
   │  ├─ Input tokens: ~360 (increased from ~100)
   │  │  ├─ system: BASE_INSTRUCTIONS + skill list (unchanged)
   │  │  ├─ + Full air-conditioner SKILL.md (~260 tokens) ← NEW
   │  │  ├─ assistant: Previous tool call message
   │  │  ├─ tool_result: Load skill result with instructions
   │  │  └─ user: '开客厅空调到二十六度'
   │  │
   │  ├─ LLM Processing:
   │  │  ├─ "I have full AC rules now"
   │  │  ├─ "User wants: turn on living room AC"
   │  │  ├─ "Set temperature to 26°C"
   │  │  ├─ "Room is explicit: 客厅 → living_room"
   │  │  ├─ "Execute two actions: turn_on, then set_temp"
   │  │  ├─ "Then output final message"
   │  │
   │  ├─ Output tokens: ~80
   │  │  ├─ Tool call 1: {
   │  │  │    "name": "control_air_conditioner",
   │  │  │    "arguments": {
   │  │  │      "room": "living_room",
   │  │  │      "action": "turn_on"
   │  │  │    }
   │  │  │  }
   │  │  ├─ (agent waits for tool result)
   │  │  ├─ Tool call 2: {
   │  │  │    "name": "control_air_conditioner",
   │  │  │    "arguments": {
   │  │  │      "room": "living_room",
   │  │  │      "action": "set_temperature",
   │  │  │      "temperature": 26
   │  │  │    }
   │  │  │  }
   │  │  ├─ (agent waits for tool result)
   │  │  └─ Final text: "好的，客厅空调已经开到二十六度。"
   │  │
   │  ├─ Network time: ~200ms each way
   │  └─ Inference time: ~400ms
   │
   └─ Latency breakdown for PASS 2:
      ├─ Network upload: ~200ms
      ├─ OpenAI inference: ~400ms (with larger context)
      └─ Network download: ~200ms

4. TOOL EXECUTION PHASE
   ├─ Tool 1: control_air_conditioner(room="living_room", action="turn_on")
   │  ├─ Action:
   │  │  ├─ Read AC_LIVING_ROOM_IP from environment
   │  │  ├─ Instantiate AcPartner client
   │  │  ├─ Call acPartner.on()
   │  │  ├─ Build MIOT protocol packet: siid=3, piid=1, value=true
   │  │  ├─ Send UDP packet to AC device IP:54321
   │  │  ├─ Receive and decrypt response
   │  │  └─ Update local state
   │  │
   │  ├─ Network time to device: ~30ms
   │  │
   │  └─ Result: { ok: true, power: true, message: "开启成功" }
   │
   ├─ Tool 2: control_air_conditioner(room="living_room", action="set_temperature", temperature=26)
   │  ├─ Action:
   │  │  ├─ Same AcPartner client
   │  │  ├─ Call acPartner.setTargetTemperature(26)
   │  │  ├─ Build MIOT protocol packet: siid=3, piid=4, value=26
   │  │  ├─ Send UDP packet
   │  │  └─ Receive response
   │  │
   │  ├─ Network time to device: ~30ms
   │  │
   │  └─ Result: { ok: true, temperature: 26, message: "设置成功" }
   │
   └─ Agent loop recognizes "no more tool calls" and exits with final text

5. HISTORY PERSISTENCE
   ├─ commitHistory(turnInput, result.history)
   ├─ Merge and filter:
   │  ├─ Keep: user/assistant/system messages
   │  └─ Remove: tool_call/tool_result entries
   ├─ Truncate to historyMaxItems (20)
   ├─ scheduleHistoryFlush()
   │  └─ Async write:
   │     ├─ Create temp file: .runtime/agent-history/2026-05-29.json.tmp
   │     ├─ Write filtered history to temp
   │     └─ Atomic rename temp → final file
   │
   └─ Stored in .runtime/agent-history/2026-05-29.json:
      ├─ (previous turns...)
      ├─ { role: 'user', content: '开客厅空调到二十六度' }
      └─ { role: 'assistant', content: '好的，客厅空调已经开到二十六度。' }

6. RESPONSE TO USER (~500ms TTS)
   ├─ DialogSession receives final text
   ├─ TencentTtsClient converts to speech
   ├─ Audio played through speaker
   └─ State transitions back to listening

┌─────────────────────────────────────────────────────────────────────────────┐
│                            TOTAL LATENCY BUDGET                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ PASS 1 (skill selection):        ~800ms  (400ms inference + 400ms network)   │
│ load_skill tool:                 ~50ms   (file I/O)                         │
│ PASS 2 (execution):              ~800ms  (400ms inference + 400ms network)   │
│ Tool execution:                  ~100ms  (2x AC commands ~30ms each)        │
│ TTS synthesis & playback:        ~500ms  (Tencent cloud TTS)                │
│ ─────────────────────────────────────────────────────────────────────────    │
│ TOTAL:                           ~2.2 seconds                               │
│ ─────────────────────────────────────────────────────────────────────────    │
│ Where network dominates:         ~1.6 seconds (2x 400ms round-trips)        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Game Console Control Flow (Multi-Layer Validation)

```
User: "我想玩游戏" (I want to play)
   │
   ├─ PASS 1 → PASS 2 (load_skill + full game rules)
   │
   └─ LLM Output: "是余晓还是余跃想玩?"
      (must confirm which child)

User: "余晓"
   │
   ├─ PASS 1 → PASS 2 (reload game rules in context)
   │
   ├─ LLM Logic:
   │  ├─ "Child is specified: 余晓 (yuxiao)"
   │  ├─ "Rules say: 先调 status() 看配额"
   │  └─ "Call status before start_game"
   │
   ├─ Tool Call: control_game_console(action: "status")
   │  │
   │  └─ GameConsoleController.status()
   │     ├─ Layer 0: Check if 余晓 is valid child → YES (in CHILDREN)
   │     ├─ Query GameQuotaService.getRemainingQuota("yuxiao")
   │     │  ├─ Read .runtime/game-quota.json
   │     │  ├─ Check if date == today
   │     │  │  └─ If no: reset quota to 60 min
   │     │  └─ Return remaining minutes
   │     │
   │     └─ Response:
   │        └─ {
   │             "ok": true,
   │             "quotas": [
   │               { "child": "yuxiao", "label": "余晓", "remaining": 60 },
   │               { "child": "yuyue", "label": "余跃", "remaining": 60 }
   │             ]
   │           }
   │
   └─ LLM Sees: "Remaining 60 minutes available"
      Output: "想玩多少分钟？" (how many minutes?)

User: "30"
   │
   ├─ PASS 1 → PASS 2
   │
   ├─ LLM has all info now:
   │  ├─ child = "yuxiao"
   │  ├─ minutes = 30
   │  └─ Available quota ≥ 30
   │
   ├─ Tool Call: control_game_console(
   │              action: "start_game",
   │              child: "yuxiao",
   │              minutes: 30)
   │
   └─ GameConsoleController.start("yuxiao", 30, announcer)
      │
      ├─ VALIDATION LAYER 1: Is child valid?
      │  ├─ CHILDREN["yuxiao"] exists? → YES
      │  └─ Continue...
      │
      ├─ VALIDATION LAYER 2: Is today a play day?
      │  ├─ today = Thursday (4)
      │  ├─ yuxiao.playDaysOfWeek = [5, 6] (Sat, Sun)
      │  └─ 4 not in [5, 6] → FAIL!
      │     └─ Return: {
      │         "ok": false,
      │         "message": "今天不能玩游戏"
      │       }
      │     └─ LLM Output: "今天不能玩游戏，只能周末玩"
      │
      │ (If Layer 2 passed, continue...)
      │
      ├─ VALIDATION LAYER 3: Daily quota available?
      │  ├─ remaining = await quotaService.getRemainingQuota("yuxiao")
      │  ├─ remaining (60) ≥ minutes (30)? → YES
      │  └─ Continue...
      │
      ├─ VALIDATION LAYER 4: No active session?
      │  ├─ this.activeSession?.child === "yuxiao"? → NO (null)
      │  └─ Continue...
      │
      ├─ VALIDATION LAYER 5: Plug reachable?
      │  ├─ Call this.gosundPlug.turnOn('s1')
      │  ├─ Try to contact Gosund plug at GOSUND_PLUG_IP:6668
      │  ├─ Receives response? → YES (connected)
      │  └─ Continue...
      │
      ├─ ALL LAYERS PASSED: Proceed
      │
      ├─ State Update:
      │  └─ this.activeSession = {
      │       child: "yuxiao",
      │       startedAt: Date.now(),
      │       minutes: 30
      │     }
      │
      ├─ Schedule Timer with Announcements
      │  │
      │  ├─ T + 25 min (5 min remaining):
      │  │  └─ announcer.announce("余晓还能玩5分钟")
      │  │     └─ DialogSession.tts.synthesizeAndPlay(...)
      │  │        └─ Tencent TTS → Speaker
      │  │
      │  ├─ T + 29 min (1 min remaining):
      │  │  └─ announcer.announce("余晓还能玩1分钟，要停了")
      │  │     └─ TTS → Speaker
      │  │
      │  └─ T + 30 min (expiry):
      │     ├─ await this.gosundPlug.turnOff('s1')
      │     ├─ announcer.announce("时间到，游戏机已关闭")
      │     ├─ this.activeSession = null
      │     ├─ Update quota: deductMinutes("yuxiao", 30)
      │     └─ Write to .runtime/game-quota.json:
      │        └─ {
      │             "yuxiao": {
      │               "date": "2026-05-29",
      │               "quotaMin": 60,
      │               "usedMin": 30,
      │               "remaining": 30
      │             }
      │           }
      │
      ├─ Quota Persistence
      │  ├─ GameQuotaService.deductMinutes("yuxiao", 30)
      │  ├─ Read current state from .runtime/game-quota.json
      │  ├─ Deduct minutes and write back
      │  └─ Next check will see: remaining = 30
      │
      └─ Return to LLM
         └─ {
              "ok": true,
              "message": "好的，余晓可以玩30分钟",
              "activeSession": {
                "child": "yuxiao",
                "startedAt": 1716966000000,
                "minutes": 30
              }
            }

LLM Output: "好的，余晓可以玩30分钟。"
   │
   └─ DialogSession.tts → Speaker → User hears response

--- DAILY QUOTA RESET ---

Day 1 (2026-05-29):
├─ start_game(yuxiao, 30) → remaining = 30
├─ (later) start_game(yuxiao, 20) → remaining = 10
└─ End of day: .runtime/game-quota.json:
   └─ { "yuxiao": { "date": "2026-05-29", "used": 50, "remaining": 10 } }

Day 2 (2026-05-30) - Next Morning:
├─ Agent starts, loads OpenAIAgentRuntime
├─ User: "还能玩多久?" (how much time left?)
├─ Tool: control_game_console(action: "status")
├─ GameQuotaService.getRemainingQuota("yuxiao"):
│  ├─ Read .runtime/game-quota.json
│  ├─ Check: file.date ("2026-05-29") !== today ("2026-05-30")? → YES
│  ├─ Reset: quota = 60 (daily reset!)
│  ├─ Save back to file
│  └─ Return: 60
│
└─ Response: "余晓还能玩60分钟。"
```

---

## 3. Air Conditioner Control - Device Communication

```
User: "把客厅和卧室的空调都打开" (Turn on living room and bedroom AC)
   │
   ├─ PASS 1 → PASS 2 (load_skill + full AC rules)
   │
   ├─ LLM Logic with Full Rules:
   │  ├─ "Rules say: 批量操作需要确认"
   │  │  (batch operations need confirmation)
   │  └─ "Multiple rooms specified: 客厅, 卧室"
   │     "This is batch operation"
   │
   └─ LLM Output: "确定要开客厅和卧室的空调吗？"
      (confirm before batch)

User: "确定" (Yes, confirm)
   │
   ├─ PASS 1 → PASS 2
   │
   ├─ LLM Logic:
   │  ├─ Context has: "User wants: turn on 客厅 and 卧室"
   │  ├─ Action: turn_on for both rooms
   │  └─ Execute sequentially: turn_on(living_room), turn_on(master_bedroom)
   │
   ├─ Tool Call 1: control_air_conditioner(
   │                room: "living_room",
   │                action: "turn_on")
   │  │
   │  └─ Handler:
   │     ├─ ROOMS.find(r => r.key === "living_room")
   │     │  └─ Config: {
   │     │       key: "living_room",
   │       label: "客厅",
   │       envKey: "AC_LIVING_ROOM_IP",
   │       envTokenKey: "AC_LIVING_ROOM_TOKEN"
   │     }
   │     │
   │     ├─ readRoomConfig("living_room")
   │     │  ├─ Read environment variables
   │     │  └─ Return: { ip: "192.168.1.51", token: "..." }
   │     │
   │     ├─ Instantiate AcPartner client
   │     │  └─ new AcPartner("192.168.1.51", "...")
   │     │
   │     ├─ Call acPartner.on()
   │     │  │
   │     │  └─ MIOT Protocol (Xiaomi IoT Standard)
   │     │     │
   │     │     ├─ Build payload:
   │     │     │  ├─ siid = 3  (Service ID: air-conditioner)
   │     │     │  ├─ piid = 1  (Property ID: power)
   │     │     │  └─ value = true
   │     │     │
   │     │     ├─ Encrypt payload with token (miio protocol)
   │     │     │  └─ AES-128 CBC mode
   │     │     │
   │     │     ├─ Build UDP packet with header:
   │     │     │  ├─ Magic number: 0x2131
   │     │     │  ├─ Device ID
   │     │     │  ├─ Timestamp
   │     │     │  ├─ MD5 checksum
   │     │     │  └─ Encrypted payload
   │     │     │
   │     │     ├─ Send UDP to device
   │     │     │  ├─ Destination: 192.168.1.51:54321
   │     │     │  └─ Timeout: 5 seconds
   │     │     │
   │     │     ├─ Device receives, decrypts, executes:
   │     │     │  └─ IR blaster sends power-on code to AC unit
   │     │     │     └─ (RC protocol, 38kHz carrier)
   │     │     │
   │     │     ├─ Device responds:
   │     │     │  └─ UDP response with status ACK
   │     │     │
   │     │     └─ AcPartner client decrypts response
   │     │        └─ Extract: { power: true, temp: 24, mode: "cool" }
   │     │
   │     └─ Return tool result:
   │        └─ {
   │             "ok": true,
   │             "room": "客厅",
   │             "action": "turn_on",
   │             "status": { power: true, temp: 24, mode: "cool" },
   │             "message": "客厅空调已打开"
   │           }
   │
   ├─ Tool Call 2: control_air_conditioner(
   │                room: "master_bedroom",
   │                action: "turn_on")
   │  │
   │  └─ (Same flow as Tool Call 1, but for master_bedroom)
   │     ├─ Read AC_MASTER_BEDROOM_IP, AC_MASTER_BEDROOM_TOKEN
   │     ├─ Send MIOT packet to 192.168.1.52:54321
   │     ├─ Receive device response
   │     └─ Return: { ok: true, room: "主卧", message: "主卧空调已打开" }
   │
   └─ LLM Output:
      └─ "好的，客厅和主卧空调已经打开。"

┌─────────────────────────────────────────────────────────────────────────────┐
│                      MIOT PROTOCOL DEEP DIVE                                │
│                                                                             │
│  Standard Xiaomi protocol for IoT device control:                           │
│  ├─ Service-based model: Each capability = one service                     │
│  ├─ Properties: Each property has Service ID + Property ID                 │
│  └─ Example: Air Conditioner Service (siid=3)                              │
│     ├─ piid=1: Power (true/false)                                          │
│     ├─ piid=2: Mode (0=cool, 1=heat, 2=auto, 3=fan, 4=dehumidify)        │
│     ├─ piid=4: Target Temperature (16-30°C)                               │
│     ├─ piid=5: Fan Level (0=auto, 1=low, 2=medium, 3=high)               │
│     └─ piid=6: Current Temperature (read-only)                            │
│                                                                             │
│  Communication Flow:                                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ 1. AcPartner.setProperty(siid=3, piid=1, value=true)                 │  │
│  │    └─ Encode as MIOT message                                          │  │
│  │                                                                        │  │
│  │ 2. Encrypt with token:                                                │  │
│  │    ├─ IV = MD5(token + timestamp)[:16]                               │  │
│  │    ├─ Key = MD5(token)                                                │  │
│  │    └─ Ciphertext = AES-128-CBC(message, key, iv)                    │  │
│  │                                                                        │  │
│  │ 3. Build miio packet:                                                 │  │
│  │    ├─ Magic: 0x2131                                                   │  │
│  │    ├─ Length: payload size                                            │  │
│  │    ├─ Unknown: 0x0000                                                 │  │
│  │    ├─ Device ID: 11xxxxxxxx (from token first 8 chars)               │  │
│  │    ├─ Timestamp: current unix timestamp                               │  │
│  │    ├─ MD5: MD5(header + ciphertext + token)                          │  │
│  │    └─ Payload: ciphertext                                             │  │
│  │                                                                        │  │
│  │ 4. Send UDP(device_ip:54321, packet)                                 │  │
│  │                                                                        │  │
│  │ 5. Device receives and validates:                                     │  │
│  │    ├─ Check magic number                                              │  │
│  │    ├─ Verify MD5 signature                                            │  │
│  │    ├─ Decrypt payload with token                                      │  │
│  │    └─ Execute command                                                 │  │
│  │                                                                        │  │
│  │ 6. Device sends IR code:                                              │  │
│  │    ├─ Via IR blaster (Xiaomi AC Partner)                             │  │
│  │    └─ Target: physical AC unit (any brand)                           │  │
│  │                                                                        │  │
│  │ 7. Device sends response:                                             │  │
│  │    └─ UDP response with command result                                │  │
│  │                                                                        │  │
│  │ 8. AcPartner client:                                                  │  │
│  │    ├─ Receives UDP response                                           │  │
│  │    ├─ Decrypt with same token/IV                                      │  │
│  │    └─ Parse result and update state                                   │  │
│  │                                                                        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  Why UDP (not TCP)?                                                         │
│  ├─ Xiaomi devices prefer UDP for speed (no handshake overhead)            │
│  ├─ LAN-only communication (no internet required)                          │
│  ├─ Stateless: packet = full command                                       │
│  └─ ~30ms typical round-trip on 2.4GHz WiFi                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Dialogue State Machine - Complete Cycle

```
        ┌──────────────────────────────────┐
        │    1. IDLE STATE                   │
        │                                    │
        │ - Listening for wake word          │
        │ - WakeWordService running locally  │
        │ - Low power consumption            │
        │ - Sherpa-ONNX model on CPU         │
        └──────────────┬───────────────────┘
                       │
                       │ (Wake word detected)
                       │ Event: 'wake'
                       │ PCM audio matches "小鱼" keyword
                       ▼
        ┌──────────────────────────────────┐
        │    2. LISTENING STATE              │
        │                                    │
        │ - Capture audio after wake word   │
        │ - Stream to TencentAsrClient      │
        │ - Show partial ASR results        │
        │ - Event: 'asr' fired              │
        │                                    │
        │ Example:                           │
        │   User speaks: "开客厅空调..."   │
        │   ASR events:                      │
        │   - "开"                          │
        │   - "开客"                        │
        │   - "开客厅"                      │
        │   - "开客厅空"                    │
        │   - "开客厅空调" (final)          │
        │                                    │
        │ Detection: Silence > 1s            │
        │   → ASR finalization triggers      │
        └──────────────┬───────────────────┘
                       │
                       │ (ASR complete + silence)
                       │ Event: 'asr'
                       │ Final text: "开客厅空调到二十六度"
                       ▼
        ┌──────────────────────────────────┐
        │    3. THINKING STATE               │
        │                                    │
        │ - Call OpenAIAgentRuntime.run()   │
        │ - Execute two-pass inference      │
        │   ├─ PASS 1: Skill selection      │
        │   ├─ load_skill tool execution    │
        │   └─ PASS 2: Action execution     │
        │ - Process tool calls              │
        │ - Generate final response text    │
        │                                    │
        │ Timing: ~1.6-2 seconds            │
        │   (2x OpenAI calls + tool exec)   │
        │                                    │
        │ Event: 'agent' fired              │
        │   when inference complete         │
        └──────────────┬───────────────────┘
                       │
                       │ (Inference complete)
                       │ Event: 'agent'
                       │ Response: "好的，客厅空调已经开到二十六度。"
                       ▼
        ┌──────────────────────────────────┐
        │    4. SPEAKING STATE               │
        │                                    │
        │ - Convert text to speech          │
        │ - TencentTtsClient synthesis      │
        │ - Sentence splitting (on-the-fly) │
        │ - Parallel synthesis              │
        │ - Audio playback                  │
        │                                    │
        │ Process:                           │
        │   Input: "好的，客厅空调已经开到 │
        │          二十六度。"             │
        │                                    │
        │   Split sentences:                 │
        │   - Sentence 1: "好的，"          │
        │   - Sentence 2: "客厅空调已经开到 │
        │     二十六度。"                  │
        │                                    │
        │   Synthesis (parallel):            │
        │   - Request 1 → TTS cloud         │
        │   - Request 2 → TTS cloud         │
        │   - Get audio back ~200-300ms     │
        │                                    │
        │   Playback:                        │
        │   - Play sentence 1 audio         │
        │   - Play sentence 2 audio         │
        │                                    │
        │ Event: 'tts' fired                │
        │   when playback complete          │
        └──────────────┬───────────────────┘
                       │
                       │ (Audio playback complete)
                       │ Event: 'tts'
                       ▼
        ┌──────────────────────────────────┐
        │    5. FOLLOWUP_WAIT STATE          │
        │                                    │
        │ - Listen for follow-up command    │
        │ - Reduce wake word sensitivity    │
        │ - Accept direct commands          │
        │ - Timeout: 10 seconds             │
        │                                    │
        │ Paths:                             │
        │   A. User speaks follow-up        │
        │      └─ New utterance detected    │
        │         → ASR capture             │
        │         → LISTENING state         │
        │                                    │
        │   B. No input for 10 seconds      │
        │      └─ Timeout triggers          │
        │         → Reset to IDLE state     │
        │                                    │
        │ Follow-up example:                 │
        │   Previous: User "开客厅空调"     │
        │   Response: "还需要设置什么吗？" │
        │   User: "再升温两度"             │
        │   → New command → LISTENING      │
        │                                    │
        │ Timeout example:                   │
        │   User silent > 10s                │
        │   → Timeout → IDLE                │
        │   → Ready for next wake word      │
        └──────────────┬───────────────────┘
                       │
                       ├─ (Follow-up detected)
                       │  └─ → LISTENING state
                       │
                       └─ (Timeout after 10s)
                          └─ → IDLE state

┌─────────────────────────────────────────────────────────────────────────────┐
│                       MULTI-TURN CONVERSATION EXAMPLE                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│ Turn 1:                                                                     │
│   User: "我想玩游戏"                                                       │
│   System: LISTENING → THINKING → SPEAKING: "是余晓还是余跃想玩?"        │
│                     → FOLLOWUP_WAIT                                        │
│                                                                             │
│ Turn 2 (follow-up):                                                        │
│   User: "余晓"                                                            │
│   System: LISTENING → THINKING → SPEAKING: "想玩多少分钟？"            │
│                     → FOLLOWUP_WAIT                                        │
│                                                                             │
│ Turn 3 (follow-up):                                                        │
│   User: "30分钟"                                                          │
│   System: LISTENING → THINKING:                                            │
│           ├─ PASS 1: load_skill("game")                                   │
│           ├─ PASS 2: All info ready                                       │
│           │          ├─ Layer 1-2-3: Validation passed                   │
│           │          ├─ Gosund plug: turnOn('s1')                        │
│           │          ├─ Timer scheduled                                   │
│           │          └─ Quota deducted                                    │
│           │
│           → SPEAKING: "好的，余晓可以玩30分钟。"                        │
│           → FOLLOWUP_WAIT                                                 │
│                                                                             │
│ (T+5min during game):                                                       │
│   Timer event: Announcer called (dependency injection)                     │
│   → DialogSession.tts.synthesizeAndPlay("余晓还能玩5分钟")              │
│   → Audio played interrupting potential user input                         │
│                                                                             │
│ (T+30min):                                                                  │
│   Timer expiry: Plug turned off, final announcement                        │
│   User cannot play anymore until next day (quota reset)                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Tool Discovery and Execution Routing

```
Agent Initialization (OpenAIAgentRuntime constructor)
   │
   ├─ Discover Skills (one-time at startup)
   │  ├─ Scan skills/ directory
   │  ├─ Find SKILL.md files
   │  ├─ Extract: name + description only
   │  └─ Result: this.skills = [
   │       { name: "game", description: "..." },
   │       { name: "air-conditioner", description: "..." },
   │       { name: "reminder", description: "..." },
   │       { name: "music", description: "..." }
   │     ]
   │
   ├─ Create Tools Array
   │  │
   │  ├─ Special Tool: createLoadSkillTool(this.skills)
   │  │  └─ Parameters: { name: enum of skill names }
   │  │     (LLM can only load discovered skills)
   │  │
   │  ├─ Execution Tools (always available):
   │  │  ├─ controlAirConditionerTool
   │  │  │  └─ Parameters: {room, action, temperature, delta, mode, fan}
   │  │  ├─ controlGameConsoleTool
   │  │  │  └─ Parameters: {action, child, minutes}
   │  │  ├─ manageReminderTool
   │  │  │  └─ Parameters: {action, text, time}
   │  │  └─ ... (other tools)
   │  │
   │  ├─ Utility Tools (always available):
   │  │  ├─ webSearchTool
   │  │  ├─ readFileTool / writeFileTool
   │  │  ├─ getCurrentTimeTool
   │  │  └─ ... (others)
   │  │
   │  └─ Create Agent with this tools array
   │     └─ this.agent = new Agent({
   │          name: "Home Voice Assistant",
   │          model: "gpt-4o",
   │          tools: [all 12 tools],
   │          instructions: BASE_INSTRUCTIONS + buildSkillsPromptSection()
   │        })
   │
   └─ OpenAI Agents SDK now has:
      └─ Tool registry: { "load_skill": {...}, "control_air_conditioner": {...}, ... }

When LLM calls tool:
   │
   ├─ LLM generates: { "type": "function", "name": "control_air_conditioner", ... }
   │
   ├─ OpenAI Agents SDK routing (NO CUSTOM ROUTER NEEDED):
   │  ├─ Search tools array for: tool.name === "control_air_conditioner"
   │  ├─ Found: controlAirConditionerTool object
   │  ├─ Extract parameters from LLM output
   │  └─ Call: controlAirConditionerTool.handler({ room, action, ... })
   │
   ├─ Tool handler executes (domain-specific logic):
   │  ├─ Example: controlAirConditionerTool handler
   │  │  ├─ Receive: { room: "living_room", action: "turn_on" }
   │  │  ├─ Look up ROOMS config
   │  │  ├─ Read environment variables
   │  │  ├─ Instantiate device client (AcPartner)
   │  │  ├─ Call device method (on())
   │  │  └─ Return: { ok: true, status, message }
   │  │
   │  └─ Result added to history for LLM to see
   │
   ├─ Routing Summary:
   │  ├─ Tool call dispatch: Automatic (SDK by name)
   │  ├─ Parameter validation: OpenAI schema validation
   │  ├─ Error handling: Try/catch in each handler
   │  ├─ Custom routing: NONE (not needed)
   │  └─ Magic: Entirely SDK-driven
   │
   └─ Agent loop repeats until:
      ├─ LLM outputs final text (no more tool calls), OR
      ├─ Maximum turns (500) exceeded
```

---

## 6. History Persistence - Atomic Write Pipeline

```
Multiple conversation turns
   │
   ├─ Turn 1: "开空调" (open AC)
   │  ├─ LLM processes and responds
   │  ├─ commitHistory() called
   │  ├─ history = [
   │  │   { role: 'user', content: '开空调' },
   │  │   { role: 'assistant', content: '...' }
   │  │ ]
   │  └─ scheduleHistoryFlush() → Queue write
   │
   ├─ Turn 2: "升温" (increase temperature) - immediately after
   │  ├─ LLM processes and responds
   │  ├─ commitHistory() called
   │  ├─ history = [
   │  │   { role: 'user', content: '开空调' },
   │  │   { role: 'assistant', content: '...' },
   │  │   { role: 'user', content: '升温' },
   │  │   { role: 'assistant', content: '...' }
   │  │ ]
   │  └─ scheduleHistoryFlush() → Queue write
   │
   └─ Turn 3: "多少度？" (what temperature?)
      ├─ LLM processes and responds
      ├─ commitHistory() called
      ├─ history = [ 6 items ]
      └─ scheduleHistoryFlush() → Queue write

Persistence Pipeline (no race conditions):
   │
   ├─ historyWriteChain = Promise.resolve()
   │
   ├─ Turn 1 scheduleHistoryFlush():
   │  └─ this.historyWriteChain = Promise.resolve()
   │     .catch(() => undefined)  // Ignore any error from 'undefined'
   │     .then(async () => {
   │       // WRITE #1
   │       mkdirSync('.runtime/agent-history', { recursive: true })
   │       writeFileSync('.runtime/agent-history/2026-05-29.json.tmp',
   │                     JSON.stringify(snapshot1), 'utf8')
   │       renameSync(...tmp, ...json)  // ATOMIC
   │     })
   │
   ├─ Turn 2 scheduleHistoryFlush(): (while Turn 1 write in progress)
   │  └─ this.historyWriteChain = [WAITING FOR TURN 1 WRITE]
   │     .catch(() => undefined)
   │     .then(async () => {
   │       // WRITE #2 - won't start until WRITE #1 complete
   │       mkdirSync(...) // Already exists
   │       writeFileSync(...tmp2, snapshot2)
   │       renameSync(...tmp2, ...json)  // Overwrites previous
   │     })
   │
   ├─ Turn 3 scheduleHistoryFlush(): (while Turn 2 write in progress)
   │  └─ this.historyWriteChain = [WAITING FOR TURN 2 WRITE]
   │     .catch(() => undefined)
   │     .then(async () => {
   │       // WRITE #3
   │       ...
   │     })
   │
   └─ Execution order guaranteed:
      ├─ WRITE #1 completes (2 items)
      ├─ WRITE #2 completes (4 items) → overwrites file
      └─ WRITE #3 completes (6 items) → overwrites file

Final File State:
   │
   └─ .runtime/agent-history/2026-05-29.json
      └─ [
           { role: 'user', content: '开空调' },
           { role: 'assistant', content: '...' },
           { role: 'user', content: '升温' },
           { role: 'assistant', content: '...' },
           { role: 'user', content: '多少度？' },
           { role: 'assistant', content: '...' }
         ]

Key Benefits:
   ├─ Serial writes: Prevents interleaved corruption
   ├─ Atomic rename: File always valid (no half-written state)
   ├─ Non-blocking: Writes happen async after agent loop
   ├─ Error resilience: Catches errors, continues
   └─ Daily segmentation: Auto-reset at midnight

Why filter tool calls:
   ├─ History JSON size: tool results can be large (web_search returns 5 items)
   ├─ Truncation safety: Cutting at tool_call/tool_result boundary breaks context
   ├─ Restart robustness: Don't need to replay tools (idempotent re-inference)
   └─ Privacy: Tool results (URLs, search snippets) not persisted to disk
```

