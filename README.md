# opencode-gemini-subagent

[opencode](https://opencode.ai) 플러그인 — Gemini를 서브에이전트로 활용하세요. 웹 검색 내장, 백그라운드 작업, 프리셋 자동화를 제공합니다.

## 빠른 시작

**1. opencode.json에 플러그인 추가**

```json
{
  "plugin": ["opencode-gemini-subagent"]
}
```

플러그인이 로드되면 Gemini CLI도 자동으로 설치됩니다.

**2. OAuth 인증**

```bash
npx ogs auth
```

브라우저가 열리며 Google 계정 인증을 진행합니다.

**3. 확인**

```bash
npx ogs doctor
```

모든 항목이 통과하면 준비 완료입니다.

## 사용법

플러그인은 opencode에 4개의 도구를 추가합니다:

| 도구 | 설명 |
|------|------|
| `gemini` | Gemini에게 작업 위임. 동기 또는 백그라운드 실행 |
| `gemini_result` | 백그라운드 작업의 결과 조회 |
| `gemini_cancel` | 백그라운드 작업 취소 |
| `gemini_status` | 설치, 인증, 프리셋 현황 확인 |

### Gemini에게 질문하기

```
gemini({
  prompt: "이 코드의 보안 취약점을 분석해줘",
  model: "gemini-2.5-flash"
})
```

### 백그라운드로 실행하기

```
gemini({ prompt: "...", background: true })
→ task_id 반환

gemini_result({ task_id: "gem_xxx", block: true })
→ 완료 시 결과 반환
```

### 모델

| 모델 | 속도 | 용도 |
|------|------|------|
| `gemini-3.1-flash-lite-preview` | ~7초 | 웹 검색, 팩트체크, 요약 |
| `gemini-2.5-flash` | ~10초 | 범용 |
| `gemini-3-flash-preview` | ~15초 | 복잡한 분석, 코드 리뷰 |

### Approval 모드

| 모드 | 설명 |
|------|------|
| `plan` | 기본값. 읽기 전용 |
| `auto_edit` | 파일 수정 허용 |
| `yolo` | 모든 작업 자동 승인 |

## 프리셋

마크다운 파일로 재사용 가능한 서브에이전트를 정의합니다.

### 위치

```
~/.config/opencode/agents-gemini/*.md
```

### 작성법

```markdown
---
description: "코드 리뷰어"
model: gemini-3.1-flash-lite-preview
approval_mode: plan
timeout_ms: 180000
args:
  - name: diff
    description: 리뷰할 unified diff
    required: true
  - name: focus
    description: 강조할 영역 (예: "security")
    required: false
---
다음 diff를 엄격하게 리뷰하세요.

Focus: {{focus}}

Diff:
{{diff}}
```

### 호출

```
gemini({
  subagent: "reviewer",
  diff: "diff --git a/src/app.ts ...",
  focus: "security"
})
```

### 프론트매터

| 필드 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `description` | 예 | — | 도구 설명 |
| `model` | 아니오 | 기본 모델 | Gemini 모델 ID |
| `approval_mode` | 아니오 | `plan` | `default` / `auto_edit` / `yolo` / `plan` |
| `output_format` | 아니오 | `text` | `text` / `json` / `stream-json` |
| `timeout_ms` | 아니오 | `180000` | 실행 시간 제한 (ms) |
| `args` | 아니오 | `[]` | 인자 목록 |

프롬프트 본문에서 `{{name}}`으로 인자를 참조합니다.

## CLI

```bash
npx ogs auth            # OAuth 인증
npx ogs auth:reset      # 인증 초기화
npx ogs status          # 전체 상태 확인
npx ogs doctor          # 진단 검사
npx ogs update          # Gemini CLI 업데이트
npx ogs tasks           # 백그라운드 작업 목록
npx ogs tasks clean     # 오래된 작업 정리
npx ogs mcp list        # MCP 서버 목록
npx ogs mcp add         # MCP 서버 추가
npx ogs mcp remove <n>  # MCP 서버 제거
```
