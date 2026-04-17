# backend-game-server

Focus Face Poker 실시간 게임 서버 뼈대 코드입니다.

아키텍처 문서: [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md)

## 포함 범위 (현재)
- Socket.IO 기반 테이블 입장/퇴장
- 방장(host) 수동 게임 시작
- 방장이 타임아웃/블라인드 레벨 설정 가능
- 방장 변경 가능
- 메인 화면의 설정 패널(한 탭)에서 방장 설정 관리
- 액션 처리: fold, check, call, raise(amount)
- 토너먼트형 블라인드 레벨 자동 적용(SB/BB/ANTE(BBA)/DURATION, ANTE는 메인팟 dead money)
- 버튼 포지션 로테이션
- 프리플랍/포스트플랍 액션 시작 좌석 규칙(헤즈업/멀티웨이)
- 스트리트 진행: preflop -> flop -> turn -> river (승패 판정 없이 종료)
- 사이드팟 계산/브로드캐스트(승자 분배는 임시 정책)
- 타임아웃 자동 액션: timeout_check / timeout_fold
- 테이블 상태 브로드캐스트
- 개인 홀카드 별도 전송(player:private)

## 미포함 범위, 구현 필요
- 핸드 종료 판정 여부 --> 한명이 올인하고 나머지가 콜했을 때 바로 끝나지 않는다, 종료 판정 로직을 수정해야함
- 디버깅 html(poker.html)을 조금 수정하자. 다른 플레이어 표시, 현재 포지션도 시각적으로 표시해주는게 좋을듯
- 인증(JWT)
- DB 저장(핸드 로그, 액션 로그)
- 정식 핸드 평가
- 정식 사이드팟 승자 판정/분배
- 타임아웃 정책 고도화(시간 설정 per-table, 페널티 정책)

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

설정 UI: `poker.html`의 설정 패널 열기 버튼으로 같은 탭에서 방장 설정(시작/타임아웃/블라인드 레벨/방장 변경)을 표 형태로 조작할 수 있습니다.

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
socket.emit("hand:action", { actionType: "raise", amount: 120 });
```

## 이벤트 요약
클라이언트 -> 서버
- table:join { tableId }
- player:ready {}
- table:start {}
- table:update_settings { actionTimeoutMs?, blindLevels? }
- table:transfer_host { targetUserId }
- hand:action { actionType: "fold" | "check" | "call" | "raise", amount?: number }
- table:leave {}

`table:update_settings`에서 `actionTimeoutMs`는 클라이언트 UI 기준 초 단위 입력을 ms로 변환해 보내면 됩니다.

blindLevels 예시:

```json
[
  { "smallBlind": 10, "bigBlind": 20, "ante": 0, "durationMinutes": 5 },
  { "smallBlind": 15, "bigBlind": 30, "ante": 0, "durationMinutes": 5 },
  { "smallBlind": 25, "bigBlind": 50, "ante": 5, "durationMinutes": 5 }
]
```

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
