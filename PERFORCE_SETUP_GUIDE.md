# 📘 노트북 올인원 Perforce + GitHub 하이브리드 세팅 가이드

> **기준 사양:** Windows 10/11 노트북 1대 올인원 (RAM 32GB / SSD 1TB) · 4인 팀 + Read-Only 봇(`p4bot`) · Unreal Engine 5 · `BuildServerKit Studio v2.0`

---

## 1. Windows 노트북 24시간 서버화 & 네트워크

1. **배터리 스웰링 방지:** 제조사 유틸리티(MyASUS, Lenovo Vantage, Samsung Settings 등) 또는 BIOS에서 **최대 충전량 50~80% 제한** 활성화.
2. **전원 및 재부팅 억제:**
   * 제어판 → 전원 옵션 → **덮개를 닫았을 때: 아무것도 안 함**, **절전 모드: 안 함**.
   * BIOS에 `Restore on AC Power Loss` 항목이 있다면 **Power On** 설정.
   * Windows Update → 사용 시간(Active Hours) 설정 또는 `gpedit.msc` → `컴퓨터 구성 > 관리 템플릿 > Windows 구성 요소 > Windows 업데이트`에서 자동 재부팅 억제.
3. **유선 LAN + Tailscale Mesh VPN:**
   * 공유기와 유선 LAN(또는 USB-C 이더넷) 연결 후 내부 고정 IP 할당.
   * 노트북과 팀원 PC 모두 **[Tailscale](https://tailscale.com/)** 로그인 → 공유기 포트포워딩 없이 팀원들은 `<노트북_Tailscale_IP>:1666`으로 안전하게 Perforce 접속.

---

## 2. Helix Core Server(P4D) 설치 & UE5 규칙 적용

1. **Helix Core Server (P4D) + P4 CLI** 설치 (Windows 서비스로 자동 등록, 기본 포트 `1666`).
2. **Unicode 모드 활성화 (한글 깨짐 방지):**
   ```powershell
   # P4D 서비스 잠시 중지 후 서버 루트에서 1회 실행
   net stop Perforce
   p4d -r "C:\Perforce\Server" -xi
   net start Perforce

   # 클라이언트 전역 UTF-8 설정
   p4 set P4PORT=localhost:1666
   p4 set P4CHARSET=utf8
   ```
3. **Stream Depot 생성:** 일반 디포 대신 Stream Depot(예: `//MyProject/main`) 생성.
4. **에셋 독점 잠금 (`p4 typemap`):**
   ```text
   TypeMap:
       binary+l //....uasset
       binary+l //....umap
       binary+l //....fbx
       binary+l //....png
       binary+l //....tga
       binary+l //....psd
       binary+l //....wav
       binary+l //....mp4
       binary+S //....exe
       binary+S //....dll
       binary+S //....pdb
       text+w   //....uproject
       text+w   //....uplugin
   ```
5. **`.p4ignore` (프로젝트 루트에 배치):**
   ```gitignore
   Saved/
   Intermediate/
   DerivedDataCache/
   Binaries/
   Build/
   .vs/
   .idea/
   *.sln
   *.suo
   *.opensdf
   *.sdf
   *.VC.db
   ```
   ```powershell
   p4 set P4IGNORE=.p4ignore
   ```

---

## 3. Read-Only 전용 봇(`p4bot`) & 무기한 티켓 세팅 (4인 팀 권장)

> Perforce 무료 플랜은 **최대 5유저 · 20워크스페이스**까지 파일 수 무제한입니다.  
> 팀원이 4명이므로 5번째 계정으로 `p4bot`을 만들어 **`read` 전용 권한**만 주면 자동화 스크립트가 실수로 디포를 수정·삭제할 위험을 원천 차단합니다.  
> *(추후 5명째 팀원이 합류하면 `p4 user -d p4bot` 실행 후 `BuildServerKit Studio`의 `P4USER`만 관리자 ID로 변경하면 즉시 전환됩니다.)*

```powershell
# 1) p4bot 계정 생성 (관리자 계정으로 실행)
p4 -u admin user -f p4bot

# 2) 무기한 티켓 그룹 생성 (Timeout: unlimited 설정)
p4 -u admin group automation_bots
# 편집기에서 아래 항목 설정:
#   Timeout: unlimited
#   Users:
#       p4bot

# 3) 권한 격리 (p4 protect) — p4bot에 read 전용 부여
p4 -u admin protect
# 하단에 추가:
#   read group automation_bots * //...

# 4) 노트북에서 p4bot 무기한 로그인 티켓 발급
p4 -p localhost:1666 -u p4bot login
p4 -p localhost:1666 -u p4bot login -s
```

---

## 4. 전용 워크스페이스 2개 생성 (`ws-mirror-code` / `ws-build-full`)

1. **코드 전용 미러 워크스페이스 (`ws-mirror-code`)**
   * `Root`: `C:\BuildSystem\P4MirrorRepo`
   * `Options`: `noallwrite noclobber ...` 대신 **`allwrite clobber rmdir`** 권장
   * `View`: 대용량 에셋 및 `.github` 제외
     ```text
     //MyProject/main/... //ws-mirror-code/...
     -//MyProject/main/Content/... //ws-mirror-code/Content/...
     -//MyProject/main/RawAssets/... //ws-mirror-code/RawAssets/...
     -//MyProject/main/.github/... //ws-mirror-code/.github/...
     ```
2. **전체 빌드 워크스페이스 (`ws-build-full`)**
   * `Root`: `C:\BuildSystem\Workspace\MyProject`
   * `Options`: **`allwrite clobber rmdir`** (UE5 패키징 시 `DefaultGameUserSettings.ini` 읽기 전용 충돌 방지)
   * `Stream`: `//MyProject/main` (코드 + `Content/` 전체 동기화)

---

## 5. `BuildServerKit Studio`로 파이프라인 완성 (5분 완료)

1. **`launch_app.bat`** 더블클릭 → **BuildServerKit Studio** 실행.
2. **`[GitHub & Runner]` 탭:**
   * **`[▶ GitHub 로그인 & 저장소 선택]`** → 코드 미러용 GitHub 저장소 연결.
   * **`[1] 필수 폴더 & 스크립트 일괄 배치`** → `C:\BuildSystem\Scripts`에 모든 스크립트(`Run-UEBuild.ps1`, `Sync-P4ToGitHub.ps1`, `Send-DiscordReport.ps1`, `Backup-P4Server.ps1` 등) 자동 배포.
   * **`[2] 연결된 GitHub 저장소 최초 Clone`** → `C:\BuildSystem\P4MirrorRepo`에 Git 원격 연결.
   * 템플릿 **`Perforce 하이브리드 (github_workflow_p4_build.yml)`** 선택 → **`[★ 선택 브랜치에 build.yml 원클릭 등록]`**.
   * **`[1] Runner 다운로드`** → **`[2] 저장소에 Runner 자동 등록`** → **`[▶ Runner 가동 시작]`**.
3. **`[Perforce & 미러링]` 탭:**
   * `P4PORT` (`localhost:1666`), `P4USER` (`p4bot`), `P4Stream`, `ws-build-full`, `ws-mirror-code` 확인 후 **`[연결 & 티켓 테스트]`**.
   * **`[현재 HEAD로 워터마크 초기화]`** 1회 클릭 → 이후 올라오는 모든 코드·에셋 CL이 자동 미러링됩니다.
   * **`[앱 내장 자동 미러링 타이머]`** ON 또는 **`[Windows 작업 스케줄러 등록]`** (앱이 꺼져 있어도 2분 주기 미러링).
   * P4 이메일과 GitHub 이메일이 다른 팀원만 `author_map.json` 표에 등록.
   * 새벽 정기 백업 경로(`D:\P4Backup` 등) 지정 후 **`[매일 새벽 백업 스케줄러 등록]`**.
4. **`[패키징 & 보관 관리]` 탭:**
   * **패키징 빌드 보관 개수 제한:** 기본 **사용함 · 10개 유지** (언제든 사용안함 토글 및 개수 조절 가능).
   * 그래픽 프리셋·해상도·옵션 런처(`_Launcher.exe`) 동봉 여부 설정.
5. **`[알림 · 네트워크 · 설정]` 탭:**
   * **Discord Webhook URL** / **Slack Bot Token** 입력 후 각각 **`[테스트 전송]`**.
   * **`[Tailscale IP 자동 감지]`** 후 필요 시 **원격 웹 대시보드 활성화** (기본 읽기 전용 모드) → 생성된 `http://100.x.y.z:3780` 주소를 팀원들에게 공유!

---

## 6. 빌드 트리거 규칙 요약 (1TB SSD 최적화)

| 이벤트 | 실행되는 빌드 모드 | 동작 설명 |
| :--- | :--- | :--- |
| 일반 P4 Submit (코드 또는 에셋) | **`QuickVerify`** | 아티스트 에셋 Submit도 `.p4-sync/asset_changelog.md`에 1줄 요약 기록 → 원작성자 GitHub 잔디 + 자동 증분 쿠킹 검증 |
| P4 Submit 설명에 `[package]` 또는 `[release]` 포함 | **`FullPackage`** | 전체 `.pak` 패키징 + 옵션 런처 동봉 + 10개 초과 구형 패키지 자동 정리 + Discord/Slack 알림 |
| GitHub Actions `Run workflow` 수동 실행 | 선택 (`QuickVerify` / `FullPackage`) | 특정 CL 지정 가능 (비워두면 P4 최신 `#head` 동기화) |
| 야간 스케줄 (`schedule`) | **선택사항 (기본 OFF)** | `.github/workflows/build.yml`의 `schedule:` 주석 해제 시 활성화 (새 CL이 없을 땐 자동 스킵) |
