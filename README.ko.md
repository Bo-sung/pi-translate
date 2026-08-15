# pi-translate

[pi](https://github.com/earendil-works/pi)용 로컬 LLM 번역 레이어입니다. 한국어로 쓰면 에이전트는
영어로 받습니다.

> English: [README.md](README.md)

이유는 두 가지입니다. 같은 내용이라도 한국어 프롬프트는 영어보다 토큰을 2~3배 씁니다(토크나이저가
대부분 영어로 학습돼서요). 프롬프트를 먼저 번역하면 매 턴 그만큼 아낍니다. 그리고 답변은 모델이 실제로
쓴 영어를 버리지 않으면서도 한국어로 읽을 수 있습니다.

중요한 비대칭이 하나 있습니다. **입력 방향만 에이전트가 보는 내용을 바꿉니다.** 번역된 답변은 메시지
옆에 표시 전용 세션 엔트리로 저장되므로, 다음 턴에 모델은 자기 번역문이 아니라 자기가 쓴 원문을 다시
읽습니다.

기본값은 **꺼짐**이고, 실행 단위로 강제 on/off가 가능합니다 — 워커에서 중요한 부분입니다.

## 설치

```bash
pi install git:github.com/Bo-sung/pi-translate
```

로컬 체크아웃도 됩니다.

```bash
pi install /경로/pi-translate
```

번역용 모델도 필요합니다. 작고 다국어 되는 것이면 뭐든 괜찮습니다.

```bash
ollama pull exaone3.5:7.8b
```

그다음 pi 안에서:

```
/translate model exaone3.5:7.8b
/translate on
/translate test 이 파일의 main() 함수를 리팩터링해줘.
```

`/translate`만 치면 현재 설정과 프로바이더가 실제로 응답하는지까지 보여줍니다.

## 켜고 끄기

먼저 걸리는 것이 이깁니다.

| 우선순위 | 범위 |
|---|---|
| `--translate` / `--no-translate` | 이번 실행 |
| `PI_TRANSLATE=on` / `off` | 이 프로세스 — 플래그를 넣을 수 없는 실행기용 |
| `<프로젝트>/.pi/translate.json` | 이 프로젝트 (신뢰된 프로젝트만) |
| `~/.pi/agent/translate.json` | 전역 — `/translate`가 쓰는 파일 |

작업을 받아 수행하는 워커에는 대개 번역이 필요 없습니다. `--no-translate`(또는 `PI_TRANSLATE=off`)로
저장된 설정을 건드리지 않고 이번 실행만 끌 수 있습니다. 이렇게 고정된 실행에서는 `/translate`가 "이번
실행은 flag로 off 고정" 이라고 알려줍니다 — 토글이 안 먹는 이유를 모르는 상황을 막기 위해서입니다.

`disableWhenOrcaAgent`는 [Orca](https://github.com/stablyai/orca)가 에이전트로 띄운 pane에서 자동으로
끕니다. 역시 워커 케이스인데, 그 에이전트와 직접 대화할 때는 번역을 원할 수 있으므로 기본값은 꺼둡니다.

## 명령

| 명령 | 동작 |
|---|---|
| `/translate` | 상태, 프로바이더 응답 여부, `enabled`가 결정된 경로 |
| `/translate on` / `off` | 전체 스위치 (전역 설정에 기록) |
| `/translate in off` / `out off` | 한쪽 방향만 끄기 (`on`으로 복구) |
| `/translate provider <ollama\|openai\|model>` | 백엔드 전환 |
| `/translate model <이름>` | 현재 백엔드의 모델 지정 (인자 없이 실행하면 Ollama 설치 목록) |
| `/translate lang <원어> <대상어>` | 언어 쌍 변경 (예: `lang Japanese English`) |
| `/translate test [문장]` | 왕복 번역 + 소요 시간 |
| `/translate config` | 최종 적용된 설정과 파일 경로 |

## 백엔드

```json
{
  "provider": "ollama",
  "ollama": { "endpoint": "http://localhost:11434", "model": "exaone3.5:7.8b", "timeoutSeconds": 60 },
  "openai": { "endpoint": "http://localhost:1234/v1", "model": "qwen2.5-7b", "apiKey": "", "timeoutSeconds": 60 },
  "model":  { "provider": "ollama", "modelId": "qwen2.5:7b", "timeoutSeconds": 60 }
}
```

- `ollama` — `/api/generate` 직접 호출. pi 모델 설정이 전혀 필요 없고, `keep_alive`로 턴 사이 모델
  퇴출을 막습니다.
- `openai` — OpenAI 호환 서버의 `/chat/completions`. LM Studio, llama.cpp, vLLM, 또는 키를 넣은 클라우드.
- `model` — `models.json`에 이미 선언한 모델을 `provider` + `modelId`로 재사용.

## 설정 항목

전부 `translate.json`에 들어갑니다.

| 항목 | 기본값 | 의미 |
|---|---|---|
| `enabled` | `false` | 전체 스위치 |
| `provider` | `"ollama"` | `ollama` / `openai` / `model` |
| `sourceLanguage` | `"Korean"` | 내가 쓰고 읽는 언어 |
| `targetLanguage` | `"English"` | 에이전트에게 보낼 언어 |
| `input` | `true` | 프롬프트 번역 — 토큰이 절약되는 방향 |
| `output` | `true` | 답변 번역 (표시 전용) |
| `showOriginalInput` | `true` | 번역 전 원문을 대화 기록에 남김 |
| `pinAnswerLanguage` | `true` | 에이전트에게 대상 언어로 답하라고 지시 (아래 참고) |
| `translateRpcInput` | `false` | RPC로 들어온 프롬프트도 번역 |
| `disableWhenOrcaAgent` | `false` | Orca가 띄운 에이전트 pane에서 자동 off |
| `allowRemoteEndpoint` | `false` | 루프백이 아닌 엔드포인트 허용 |
| `skipShareThreshold` | `0.2` | 답변이 "이미 내 언어"로 판정되는 한글 letter 비율 |
| `minInputShare` | `0.05` | 이 비율 미만이면 기계가 만든 텍스트로 보고 통과 |
| `maskIdentifiers` | `true` | 식별자 형태 토큰을 번역 모델에서 가림 |
| `preserveTerms` | `[]` | 그대로 둘 문자열 (예: `"Claude Code"`) |

### `pinAnswerLanguage`가 필요한 이유

번역하는 건 프롬프트뿐입니다. 툴 결과, 컨텍스트 파일, 파일 내용은 원문 그대로 모델에 들어갑니다 —
번역하면 코드가 깨지고 비용도 훨씬 큽니다. 그래서 에이전트가 한국어 문서를 읽으면 답도 한국어로 나오고,
출력 방향이 한국어→한국어라는 무의미한 왕복이 되어 고유명사만 망가집니다. 답변 언어를 고정하면 설계가
전제하는 불변식이 유지됩니다.

### `minInputShare`가 필요한 이유

입력 훅에 들어오는 게 전부 사람이 친 프롬프트는 아닙니다. Orca는 4.7KB짜리 영어 워커 프리앰블 뒤에 태스크
명세를 붙여 주입하는데, **한글 비율 1.4%**짜리 그 전체가 번역되면서 12초가 걸렸고, 프리앰블이 워커에게
실행하라고 지시하는 `orca orchestration worker_done` 명령 문자열까지 바뀌어 에이전트가 횡설수설하게
됐습니다. 이 비율 미만이면 그대로 통과시킵니다. 실제 프롬프트는 이 값보다 훨씬 높습니다.

또한 번역 결과에서 가려둔 조각이 하나라도 사라졌으면(7B 모델이 `[[6]]`을 `**[6]**`로 바꾸는 식) 결과를
버리고 원문을 씁니다. 명령어가 지워진 채 에이전트에 도달하는 것보다는 번역을 안 하는 편이 낫습니다.

### `skipShareThreshold`가 0.2인 이유

이미 내 언어인 답변은 건너뛰어야 하고, 판정은 "letter 중 한글 비율"로 합니다. 한국어 기술 문서는 직관보다
훨씬 낮게 나옵니다. 실제 측정값으로 `AgentManager`, `WPF`, `.NET`, `git worktree`가 섞인 한국어 답변이
**0.447**, 그 원본인 한국어 README가 **0.494**였습니다. 임계값을 0.5로 두면 명백한 한국어를 다시
번역합니다.

## 번역되는 것과 안 되는 것

- `/`나 `!`로 시작하는 입력은 명령이라 그대로 전달됩니다.
- 코드 블록, 인라인 `` `코드` ``, `@파일경로`, 그리고 식별자 형태 토큰(`code-rules-check`,
  `AgentManager`, `src/app.ts`)은 번역 모델에 넘기기 전에 가려두고 나중에 복원합니다. 이게 없으면 7B
  모델이 `code-rules-check`를 "코드 규칙 검사"로 바꿔버려서, 읽은 사람이 그 이름을 다시 입력할 수 없게
  됩니다.
- 대신 일반적인 하이픈 영어 단어(`well-known`)도 같은 규칙에 걸려 번역되지 않고 남습니다. 그게 더
  거슬리면 `maskIdentifiers: false`로 끄면 됩니다.
- 이미 대상 언어인 텍스트는 모델을 호출하지 않고 건너뜁니다.
- 툴 호출·툴 결과·thinking 블록은 번역하지 않습니다.
- 라틴 문자끼리(영어↔스페인어)는 문자로 구분이 안 되므로 항상 모델을 거칩니다.

타임아웃이든 서버 다운이든 **실패하면 원문을 그대로 쓰고 그 사실을 알립니다.** 번역이 턴을 막는 일은
없습니다.

## 속도

프롬프트 번역은 턴 시작 전에 일어나므로 그만큼 기다립니다. 답변 번역은 에이전트를 막지 않습니다 —
어시스턴트 메시지 뒤에는 보통 툴 호출이 이어지는데 거기서 로컬 모델을 기다리면 매 턴이 멈추기 때문에,
큐에 넣고 도착하는 대로 붙입니다. print/JSON 모드만 예외로 기다립니다(프롬프트 응답 직후 종료해서
번역이 유실되기 때문).

예열된 7B 모델 기준 수백 ms ~ 수 초입니다.

## 보안

번역은 프롬프트 원문을 그대로 엔드포인트로 보냅니다. 소스 코드, 파일 경로, 때로는 비밀값까지 포함될 수
있어서 루프백이 아닌 주소는 명시적 허용이 필요합니다.

```json
{ "allowRemoteEndpoint": true, "ollama": { "endpoint": "http://192.168.1.5:11434" } }
```

허용하지 않으면 원격 엔드포인트는 "not ready"로 보고되고 아무것도 전송되지 않습니다. URL로 파싱되지
않는 값은 안전한 쪽이 아니라 원격으로 간주합니다.

## 개발

```bash
npm test
```

## 라이선스

MIT
