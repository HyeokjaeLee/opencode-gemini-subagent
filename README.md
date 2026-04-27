# opencode-gemini-subagent

[opencode](https://opencode.ai) 플러그인 — Gemini를 서브에이전트로 활용하세요. 웹 검색 내장, 백그라운드 작업, 프리셋 자동화를 제공합니다.

## 설치

`opencode.json`에 플러그인을 추가하세요. 그게 전부입니다.

```json
{
  "plugin": ["opencode-gemini-subagent"]
}
```

플러그인이 처음 로드될 때 Gemini CLI가 `~/.ogs/`에 자동으로 설치됩니다. 별도 설치 과정은 없습니다.

## 인증

opencode 내장 인증 시스템을 사용합니다.

```bash
opencode auth login
```

제공되는 목록에서 **Gemini OAuth**를 선택하면 브라우저가 열리고 Google 계정으로 인증을 진행합니다. 토큰은 `~/.ogs/sandbox/.gemini/oauth_creds.json`에 저장됩니다.

## MCP 서버

opencode 설정에 정의된 MCP 서버를 Gemini CLI 설정으로 자동 동기화합니다. 별도로 관리할 필요가 없습니다.

```json
{
  "plugin": ["opencode-gemini-subagent"],
  "mcp": {
    "figma": {
      "type": "remote",
      "url": "https://mcp.figma.com/mcp",
      "enabled": true
    },
    "my-tool": {
      "type": "local",
      "command": ["npx", "my-mcp-server"],
      "enabled": true
    }
  }
}
```

remote(HTTP) 서버와 local(command) 서버 모두 지원합니다. `enabled: false`로 설정된 서버는 동기화에서 제외됩니다.

## 도구

플러그인은 opencode에 4개의 도구를 추가합니다:

| 도구 | 설명 |
|------|------|
| `gemini` | Gemini에게 작업 위임. 동기 또는 백그라운드 실행 |
| `gemini_result` | 백그라운드 작업의 결과 조회 |
| `gemini_cancel` | 백그라운드 작업 취소 |
| `gemini_status` | 설치, 인증, 프리셋, MCP, 백그라운드 작업 현황 확인 |

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

## ogs CLI에서 마이그레이션

v0.2.0부터 독립 실행형 `ogs` CLI가 제거되었습니다. 플러그인 아키텍처로 전환되었습니다.

### 변경 요약

| 기존 (ogs CLI) | 현재 (플러그인) |
|----------------|-----------------|
| `bunx ogs auth` | `opencode auth login` → "Gemini OAuth" 선택 |
| `bunx ogs status` | `gemini_status` 도구 호출 |
| `bunx ogs doctor` | `gemini_status` 도구로 상태 확인 |
| `bunx ogs mcp add` | `opencode.json`의 `mcp` 섹션에 직접 작성 |
| `bunx ogs mcp remove` | `opencode.json`에서 해당 서버 삭제 |
| `bunx ogs tasks` | `gemini_status`의 `tasks` 필드 확인 |
| `bunx ogs update` | 플러그인 업데이트 시 Gemini CLI도 자동 갱신 |

### 마이그레이션 절차

1. `opencode.json`에 `"plugin": ["opencode-gemini-subagent"]` 추가
2. `opencode auth login`으로 Gemini OAuth 재인증 (기존 토큰 경로가 동일하면 생략 가능)
3. `opencode.json`의 `mcp` 섹션에 기존 MCP 서버 재작성
4. 완료. `ogs` CLI는 더 이상 필요하지 않습니다.

## 라이선스

MIT
