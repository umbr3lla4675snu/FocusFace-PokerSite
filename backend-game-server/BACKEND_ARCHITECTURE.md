# Focus Face Poker - 백엔드 설계안 (MVP 기준)

## 1) 목표
- 텍사스 홀덤 캐시게임 1테이블(최대 6명)부터 안정적으로 동작
- 실시간 동기화(플레이어 액션, 보드카드 공개, 팟 변화)
- 결과 재현 가능한 로그 구조(의혹 방지, 디버깅 용이)

---

## 2) 기술 스택

### 스택
- 런타임: Node.js (LTS)
- 서버 프레임워크: NestJS 또는 Express
- 실시간: Socket.IO
- DB: PostgreSQL
- 캐시/락: Redis
- ORM: Prisma
- 인증: JWT + Refresh Token

### 왜 이 조합인가
- 웹 포커는 "실시간 상태 관리"가 핵심이라 Socket.IO가 유리
- PostgreSQL은 트랜잭션/정합성이 좋아 칩, 베팅, 핸드 이력 관리에 적합
- Redis는 테이블별 게임 상태를 빠르게 관리하고, 타임아웃 처리에 편함

---

## 3) 아키텍처 개요

- API 서버: 로그인/유저/지갑/핸드 기록 조회
- 게임 서버: 방 생성, 핸드 진행, 베팅 액션 처리, 결과 브로드캐스트
- DB: 유저/테이블/핸드/액션 영속화
- Redis: 현재 진행중 핸드 상태(턴, 포트, 플레이어 상태)

구조:
1. 클라이언트가 방 입장 요청
2. 게임 서버가 현재 테이블 상태 전달
3. 플레이어 액션(폴드/콜/레이즈) 수신
4. 서버가 액션 검증 후 상태 업데이트
5. 모든 플레이어에게 실시간 브로드캐스트
6. 핸드 종료 시 DB에 핸드 결과 및 액션 로그 저장

---

## 4) 도메인 모델 (핵심 엔티티)

### User
- id
- nickname
- email
- password_hash
- created_at

### Wallet
- user_id (FK)
- balance
- updated_at

### Table
- id
- name
- max_players
- small_blind
- big_blind
- status (waiting, running)

### Seat
- table_id (FK)
- seat_no
- user_id (nullable)
- stack
- is_sitting_out

### Hand
- id
- table_id
- hand_no
- dealer_seat
- street (preflop, flop, turn, river, showdown)
- pot_total
- started_at
- ended_at

### HandPlayer
- hand_id
- user_id
- seat_no
- hole_card_1 (암호화 저장)
- hole_card_2 (암호화 저장)
- result (win/lose/split)
- win_amount

### ActionLog
- id
- hand_id
- street
- action_order
- user_id
- action_type (fold, check, call, bet, raise, all_in)
- amount
- created_at

### DeckCommit (공정성 추적용)
- hand_id
- deck_hash_before_deal
- reveal_seed_after_hand

---

## 5) 실시간 이벤트 설계 (Socket.IO)

### 클라이언트 -> 서버
- table:join { tableId }
- hand:action { handId, actionType, amount }
- player:ready {}
- ping {}

### 서버 -> 클라이언트
- table:state (전체 스냅샷)
- hand:started
- hand:street_changed
- hand:action_applied
- hand:ended
- error:event

원칙:
- 서버가 단일 진실 원천(SSOT)
- 클라이언트는 상태를 계산하지 않고 렌더링만 수행

---

## 6) REST API 설계 (최소)

### 인증
- POST /auth/register
- POST /auth/login
- POST /auth/refresh

### 유저/지갑
- GET /me
- GET /wallet

### 테이블
- GET /tables
- POST /tables/:id/join
- POST /tables/:id/leave

### 히스토리
- GET /hands?tableId=...&cursor=...
- GET /hands/:id

---

## 7) 게임 엔진 핵심 규칙

### 상태 머신
waiting -> preflop -> flop -> turn -> river -> showdown -> waiting

### 액션 검증
- 현재 턴 플레이어인지 확인
- 최소 레이즈 규칙 확인
- 스택 초과 여부 확인
- 체크 가능한 상황인지 확인

### 스트리트 전환
- 모든 활성 플레이어 액션 완료
- 혹은 올인/폴드 상태로 즉시 다음 단계

### 승패 판정
- 오픈소스 핸드 평가 라이브러리 사용 권장
- 예: poker hand evaluator 계열 라이브러리

---

## 8) 공정성/신뢰 설계 (중요)

사용자 의혹(주작) 대응을 위해 최소한 아래를 구현:
- 핸드 시작 전 셔플 결과 + seed로 deck hash 저장 (commit)
- 핸드 종료 후 seed 공개 (reveal)
- 필요 시 재현 검증 가능
- 모든 액션 로그를 순서대로 저장

효과:
- "서버가 중간에 덱 바꿨다"는 의혹에 대해 사후 검증 가능

---

## 9) 보안/안정성 체크리스트

- 비밀번호: bcrypt 해시
- JWT 만료 짧게 + refresh 토큰 분리
- Socket 인증 미들웨어 적용
- 액션 API rate limit
- 서버 시간 기준으로 타임아웃 처리
- 금액 연산은 decimal/bigint로 처리 (float 금지)

---

## 10) 폴더 구조 예시

```txt
backend/
  src/
    auth/
    users/
    wallet/
    tables/
    game-engine/
      state-machine/
      actions/
      evaluator/
      fairness/
    sockets/
    db/
  prisma/
    schema.prisma
  test/
```

---

## 11) 개발 순서 (4주 MVP)

### 1주차
- 프로젝트 생성 (NestJS + Prisma + PostgreSQL)
- User/Auth/Wallet CRUD
- 테이블 목록/입장 API

### 2주차
- Socket 연결
- 테이블 상태 동기화
- preflop 액션 처리(폴드/콜/레이즈)

### 3주차
- flop/turn/river/showdown 완성
- 팟 분배 및 승자 계산
- 핸드/액션 로그 저장

### 4주차
- 공정성(commit-reveal) 추가
- 타임아웃 자동 액션
- 테스트(규칙 단위테스트 + 통합테스트)

---

## 12) 바로 시작할 최소 구현 범위 (정말 최소)

초기에는 아래만 구현:
1. 2인 게임 고정
2. preflop만 진행
3. 액션: fold/call만 허용
4. 핸드 종료 후 승자 랜덤(임시)

그 다음 단계에서:
- 정식 핸드 평가
- 풀 스트리트
- 멀티플레이어

이렇게 하면 초반 복잡도를 크게 줄일 수 있음.

---

## 13) 초기 의사결정 권장안

- 프레임워크: NestJS
- DB: PostgreSQL
- 실시간: Socket.IO
- ORM: Prisma
- 첫 목표: "2인 preflop 완료 + 로그 저장"

이 목표를 먼저 끝내면, 이후 확장이 매우 쉬워짐.
