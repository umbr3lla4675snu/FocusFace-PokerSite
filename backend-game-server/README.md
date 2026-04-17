# backend-game-server

Focus Face Poker 실시간 게임 서버 뼈대 코드입니다.

아키텍처 문서: [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md)

## 포함 범위 (현재)
- Socket.IO 기반 테이블 입장/퇴장
- Ready 후 핸드 시작
- 액션 처리: fold, check, call
- 스트리트 진행: preflop -> flop -> turn -> river (승패 판정 없이 종료)
- 테이블 상태 브로드캐스트
- 개인 홀카드 별도 전송(player:private)

## 미포함 범위 (다음 단계)
- 인증(JWT)
- DB 저장(핸드 로그, 액션 로그)
- 정식 핸드 평가
- 블라인드/레이즈/사이드팟
- 타임아웃 자동 액션 ( 타입칩 추가 )

## 빠른 시작
1. Node.js LTS 설치
2. 현재 폴더에서 의존성 설치
3. 서버 실행

```bash
cp .env.example .env
npm install
npm run dev
```

서버 기본 포트: 4000
헬스체크: GET /health

## 소켓 연결 예시

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:4000", {
  auth: {
    userId: "u1",
    nickname: "player1",
  },
});

socket.on("connect", () => {
  socket.emit("table:join", { tableId: "default" });
});

socket.on("table:state", (state) => {
  console.log("table state", state);
});

socket.on("player:private", (state) => {
  console.log("my private", state);
});

socket.on("error:event", (e) => {
  console.error(e);
});

// 준비 완료
socket.emit("player:ready");

// 액션
socket.emit("hand:action", { actionType: "call" });
```

## 이벤트 요약
클라이언트 -> 서버
- table:join { tableId }
- player:ready {}
- hand:action { actionType: "fold" | "check" | "call" }
- table:leave {}

서버 -> 클라이언트
- system:connected
- table:state
- player:private
- hand:action_applied
- error:event

## 파일 구조

```txt
src/
  config/env.ts
  game/
    deck.ts
    state.ts
    types.ts
  socket/
    gateway.ts
    types.ts
  index.ts
```
