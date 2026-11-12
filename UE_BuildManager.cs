using System;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.CSharp;

[assembly: AssemblyTitle("BuildServerKit - Unreal Engine Build & GitHub Actions Manager")]
[assembly: AssemblyDescription("All-in-One Dedicated Build Server GUI Manager for Unreal Engine 5, GitHub Actions Self-Hosted Runner, and Slack Error Reporting")]
[assembly: AssemblyProduct("BuildServerKit")]
[assembly: AssemblyCopyright("Copyright (c) 2026 eruminyu. MIT License.")]
[assembly: AssemblyVersion("1.0.8.0")]
[assembly: AssemblyFileVersion("1.0.8.0")]

namespace BuildServerKit
{
    public static class EncodingHelper
    {
        private static readonly UTF8Encoding Utf8Strict = new UTF8Encoding(false, true);
        public static readonly UTF8Encoding Utf8WithBom = new UTF8Encoding(true);

        /// <summary>
        /// 바이트 배열이 유효한 UTF-8이면 UTF-8로 디코딩하고,
        /// cmd.exe / cl.exe(MSVC) / PowerShell 등에서 출력된 CP949(ANSI) 바이트면 시스템 기본 인코딩(CP949)으로 자동 변환합니다.
        /// </summary>
        public static string DecodeSmartBytes(byte[] bytes, int count)
        {
            if (bytes == null || count <= 0) return "";
            int offset = 0;
            if (count >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
            {
                offset = 3;
                count -= 3;
            }
            if (count <= 0) return "";

            try
            {
                return Utf8Strict.GetString(bytes, offset, count);
            }
            catch
            {
                return Encoding.Default.GetString(bytes, offset, count);
            }
        }

        /// <summary>
        /// 프로세스의 StandardOutput / StandardError BaseStream에서 줄 단위로 바이트를 읽어
        /// UTF-8과 CP949(EUC-KR)가 혼재된 출력도 글자 깨짐 없이 실시간으로 전달합니다.
        /// </summary>
        public static void ReadStreamLinesSmart(Stream stream, Action<string> onLine)
        {
            if (stream == null || onLine == null) return;
            try
            {
                using (var ms = new MemoryStream())
                {
                    byte[] buf = new byte[4096];
                    int read;
                    while ((read = stream.Read(buf, 0, buf.Length)) > 0)
                    {
                        for (int i = 0; i < read; i++)
                        {
                            byte b = buf[i];
                            if (b == (byte)'\n')
                            {
                                byte[] lineBytes = ms.ToArray();
                                int len = lineBytes.Length;
                                if (len > 0 && lineBytes[len - 1] == (byte)'\r') len--;
                                string line = DecodeSmartBytes(lineBytes, len);
                                ms.SetLength(0);
                                onLine(line);
                            }
                            else
                            {
                                ms.WriteByte(b);
                            }
                        }
                    }
                    if (ms.Length > 0)
                    {
                        byte[] rem = ms.ToArray();
                        int len = rem.Length;
                        if (len > 0 && rem[len - 1] == (byte)'\r') len--;
                        onLine(DecodeSmartBytes(rem, len));
                    }
                }
            }
            catch { }
        }
    }

    public class AppConfig
    {
        public string UE5Root { get; set; }
        public string WorkspaceRoot { get; set; }
        public string ProjectDir { get; set; }
        public string SharedAssetsDir { get; set; }
        public string ArchiveRoot { get; set; }
        public string RunnerDir { get; set; }

        // GitHub Login & Connected Repo Info (Default: Empty for clean distribution)
        public string GitHubUser { get; set; }
        public string GitHubAccessToken { get; set; }
        public string ConnectedRepoFullName { get; set; }
        public string GitRemoteUrl { get; set; }
        public string GitHubRepoUrl { get; set; }
        public string RunnerToken { get; set; }
        public string LastBranch { get; set; }
        public string ClientConfig { get; set; }

        // Default Game Packaging Display & Scalability Options
        public string DefaultQualityPreset { get; set; }
        public string DefaultResolution { get; set; }
        public string DefaultWindowMode { get; set; }
        public int DefaultFrameRateLimit { get; set; }
        public bool DefaultVSync { get; set; }
        public bool GenerateLauncherOnPackage { get; set; }

        // Slack & Network Info (Default: Empty for clean distribution)
        public string SlackBotToken { get; set; }
        public string SlackChannelId { get; set; }
        public string TailscaleIP { get; set; }
        public bool AutoSendSlack { get; set; }

        public AppConfig()
        {
            UE5Root = @"C:\Program Files\Epic Games\UE_5.8";
            WorkspaceRoot = @"C:\BuildSystem\Workspace";
            ProjectDir = "";
            SharedAssetsDir = @"C:\BuildSystem\SharedAssets";
            ArchiveRoot = @"C:\BuildArchive";
            RunnerDir = @"C:\actions-runner";

            GitHubUser = "";
            GitHubAccessToken = "";
            ConnectedRepoFullName = "";
            GitRemoteUrl = "";
            GitHubRepoUrl = "";
            RunnerToken = "";
            LastBranch = "";
            ClientConfig = "Development";

            DefaultQualityPreset = "Epic";
            DefaultResolution = "1920x1080";
            DefaultWindowMode = "WindowedFullscreen";
            DefaultFrameRateLimit = 0;
            DefaultVSync = true;
            GenerateLauncherOnPackage = true;

            SlackBotToken = "";
            SlackChannelId = "";
            TailscaleIP = "";
            AutoSendSlack = true;
        }
    }

    public class GitHubRepoItem
    {
        public string FullName { get; set; }
        public string Name { get; set; }
        public string HtmlUrl { get; set; }
        public string CloneUrl { get; set; }
        public string DefaultBranch { get; set; }
        public bool IsPrivate { get; set; }
        public string Description { get; set; }
    }

    // =========================================================================
    // GitHub Login & Repository Picker Modal Dialog
    // =========================================================================
    public class GitHubConnectDialog : Form
    {
        public string AuthenticatedUser { get; private set; }
        public string AccessToken { get; private set; }
        public GitHubRepoItem SelectedRepo { get; private set; }

        private TextBox txtToken;
        private Label lblAuthStatus;
        private TextBox txtSearch;
        private ListView lvRepos;
        private Button btnSelectRepo;
        private List<GitHubRepoItem> allRepos = new List<GitHubRepoItem>();

        private readonly Color BgDark = Color.FromArgb(24, 26, 31);
        private readonly Color BgPanel = Color.FromArgb(33, 37, 43);
        private readonly Color BgInput = Color.FromArgb(44, 49, 58);
        private readonly Color FgText = Color.FromArgb(230, 234, 240);
        private readonly Color AccentBlue = Color.FromArgb(56, 132, 255);
        private readonly Color AccentGreen = Color.FromArgb(40, 180, 99);
        private readonly Color AccentPurple = Color.FromArgb(130, 80, 223);

        public GitHubConnectDialog(string existingToken, string existingUser)
        {
            AuthenticatedUser = existingUser ?? "";
            AccessToken = existingToken ?? "";
            InitializeDialogUI();

            if (!string.IsNullOrWhiteSpace(AccessToken))
            {
                txtToken.Text = AccessToken;
                FetchUserAndReposAsync();
            }
        }

        private void InitializeDialogUI()
        {
            this.Text = "GitHub 계정 로그인 및 빌드 대상 저장소(Repository) 연결";
            this.Size = new Size(820, 620);
            this.StartPosition = FormStartPosition.CenterParent;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.BackColor = BgDark;
            this.ForeColor = FgText;
            this.Font = new Font("Malgun Gothic", 9.5f, FontStyle.Regular);

            int y = 16;

            Label lblStep1 = new Label
            {
                Text = "■ Step 1. GitHub 웹페이지에서 로그인 후 연동하기",
                Font = new Font("Malgun Gothic", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(130, 190, 255),
                Location = new Point(18, y),
                AutoSize = true
            };
            this.Controls.Add(lblStep1);
            y += 28;

            Label lblDesc1 = new Label
            {
                Text = "아래 [1. GitHub 웹 로그인 & 토큰 발급 열기] 버튼을 누르면 브라우저에서 GitHub 로그인 후 권한(repo, workflow)이 자동 선택된 페이지가 열립니다.\n발급된 토큰(ghp_...)을 아래 칸에 붙여넣고 [2. 로그인 및 내 저장소 불러오기]를 누르세요.",
                ForeColor = Color.FromArgb(170, 180, 195),
                Font = new Font("Malgun Gothic", 8.8f),
                Location = new Point(18, y),
                Size = new Size(770, 38)
            };
            this.Controls.Add(lblDesc1);
            y += 42;

            Button btnOpenWebLogin = CreateBtn("▶ 1. GitHub 웹 로그인 & 연동 토큰 발급 페이지 열기", new Point(18, y), new Size(390, 34), AccentPurple);
            btnOpenWebLogin.Click += (s, e) =>
            {
                Process.Start("https://github.com/settings/tokens/new?description=UE_Build_Deploy_Manager&scopes=repo,workflow,read:org");
            };

            Button btnGhCliLogin = CreateBtn("★ GitHub CLI(gh)가 설치된 경우 브라우저 원클릭 로그인", new Point(418, y), new Size(370, 34), BgInput);
            btnGhCliLogin.Click += async (s, e) => await TryGhCliWebLoginAsync();

            this.Controls.Add(btnOpenWebLogin);
            this.Controls.Add(btnGhCliLogin);
            y += 42;

            Label lblTk = new Label { Text = "GitHub 인증 토큰:", Location = new Point(18, y + 5), AutoSize = true };
            txtToken = new TextBox
            {
                Location = new Point(140, y),
                Width = 430,
                BackColor = BgInput,
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle,
                UseSystemPasswordChar = true
            };

            Button btnFetchRepos = CreateBtn("▶ 2. 로그인 및 내 저장소 불러오기", new Point(580, y - 2), new Size(208, 30), AccentBlue);
            btnFetchRepos.Click += (s, e) => FetchUserAndReposAsync();

            this.Controls.Add(lblTk);
            this.Controls.Add(txtToken);
            this.Controls.Add(btnFetchRepos);
            y += 36;

            lblAuthStatus = new Label
            {
                Text = "○ 아직 로그인되지 않았습니다.",
                Location = new Point(18, y),
                AutoSize = true,
                ForeColor = Color.FromArgb(255, 205, 86),
                Font = new Font("Malgun Gothic", 9f, FontStyle.Bold)
            };
            this.Controls.Add(lblAuthStatus);
            y += 32;

            // Step 2: Select Repository
            Label lblStep2 = new Label
            {
                Text = "■ Step 2. 빌드매니저에서 사용할 저장소(Repository) 선택",
                Font = new Font("Malgun Gothic", 10.5f, FontStyle.Bold),
                ForeColor = Color.FromArgb(130, 190, 255),
                Location = new Point(18, y),
                AutoSize = true
            };
            this.Controls.Add(lblStep2);
            y += 28;

            Label lblSearch = new Label { Text = "저장소 검색 필터:", Location = new Point(18, y + 4), AutoSize = true };
            txtSearch = new TextBox
            {
                Location = new Point(140, y),
                Width = 648,
                BackColor = BgInput,
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
            txtSearch.TextChanged += (s, e) => FilterRepoList();
            this.Controls.Add(lblSearch);
            this.Controls.Add(txtSearch);
            y += 34;

            lvRepos = new ListView
            {
                Location = new Point(18, y),
                Size = new Size(770, 240),
                View = View.Details,
                FullRowSelect = true,
                GridLines = true,
                BackColor = Color.FromArgb(18, 20, 25),
                ForeColor = FgText,
                BorderStyle = BorderStyle.FixedSingle
            };
            lvRepos.Columns.Add("저장소 이름 (Owner / Repo)", 270);
            lvRepos.Columns.Add("공개 여부", 95);
            lvRepos.Columns.Add("기본 브랜치", 100);
            lvRepos.Columns.Add("저장소 주소 (URL)", 280);
            lvRepos.DoubleClick += (s, e) => ConfirmSelection();
            this.Controls.Add(lvRepos);
            y += 252;

            btnSelectRepo = CreateBtn("✔ 선택한 저장소를 빌드매니저에 연결하기", new Point(18, y), new Size(580, 42), AccentGreen);
            btnSelectRepo.Font = new Font("Malgun Gothic", 10.5f, FontStyle.Bold);
            btnSelectRepo.Enabled = false;
            btnSelectRepo.Click += (s, e) => ConfirmSelection();

            Button btnCancel = CreateBtn("닫기", new Point(608, y), new Size(180, 42), BgPanel);
            btnCancel.Click += (s, e) => { this.DialogResult = DialogResult.Cancel; this.Close(); };

            lvRepos.SelectedIndexChanged += (s, e) => { btnSelectRepo.Enabled = lvRepos.SelectedItems.Count > 0; };

            this.Controls.Add(btnSelectRepo);
            this.Controls.Add(btnCancel);
        }

        private Button CreateBtn(string text, Point loc, Size sz, Color bg)
        {
            var b = new Button
            {
                Text = text,
                Location = loc,
                Size = sz,
                BackColor = bg,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            b.FlatAppearance.BorderColor = Color.FromArgb(70, 78, 92);
            return b;
        }

        private async Task TryGhCliWebLoginAsync()
        {
            lblAuthStatus.Text = "● GitHub CLI(gh) 웹 브라우저 로그인을 시도하는 중...";
            await Task.Run(() =>
            {
                try
                {
                    var psiLogin = new ProcessStartInfo("gh", "auth login --hostname github.com --web -s repo,workflow")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = false
                    };
                    using (var p = Process.Start(psiLogin))
                    {
                        if (p != null) p.WaitForExit();
                    }

                    var psiToken = new ProcessStartInfo("gh", "auth token")
                    {
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        CreateNoWindow = true
                    };
                    using (var pt = Process.Start(psiToken))
                    {
                        if (pt != null)
                        {
                            using (var ms = new MemoryStream())
                            {
                                pt.StandardOutput.BaseStream.CopyTo(ms);
                                pt.WaitForExit(3000);
                                byte[] raw = ms.ToArray();
                                string tk = EncodingHelper.DecodeSmartBytes(raw, raw.Length).Trim();
                                if (!string.IsNullOrWhiteSpace(tk))
                                {
                                    this.BeginInvoke(new Action(() =>
                                    {
                                        txtToken.Text = tk;
                                        FetchUserAndReposAsync();
                                    }));
                                    return;
                                }
                            }
                        }
                    }
                }
                catch
                {
                    this.BeginInvoke(new Action(() =>
                    {
                        MessageBox.Show("이 PC에 GitHub CLI(gh)가 설치되어 있지 않습니다.\n좌측의 [1. GitHub 웹 로그인 & 연동 토큰 발급 페이지 열기] 버튼을 사용해 주세요!", "안내", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }));
                }
            });
        }

        private async void FetchUserAndReposAsync()
        {
            string tk = txtToken.Text.Trim();
            if (string.IsNullOrWhiteSpace(tk))
            {
                MessageBox.Show("먼저 GitHub 인증 토큰을 입력해 주세요.", "입력 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            lblAuthStatus.Text = "● GitHub 계정 인증 및 저장소 목록을 불러오는 중...";
            lblAuthStatus.ForeColor = Color.FromArgb(255, 205, 86);
            allRepos.Clear();
            lvRepos.Items.Clear();

            await Task.Run(() =>
            {
                try
                {
                    var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

                    // 1. Get authenticated user
                    string userJson = MainForm.GitHubApiGet("https://api.github.com/user", tk);
                    var userDict = serializer.Deserialize<Dictionary<string, object>>(userJson);
                    string login = userDict != null && userDict.ContainsKey("login") ? userDict["login"].ToString() : "";

                    // 2. Get repositories (personal + collaborator + orgs)
                    string reposJson = MainForm.GitHubApiGet("https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member", tk);
                    var rawList = serializer.Deserialize<List<Dictionary<string, object>>>(reposJson);

                    var parsed = new List<GitHubRepoItem>();
                    if (rawList != null)
                    {
                        foreach (var r in rawList)
                        {
                            parsed.Add(new GitHubRepoItem
                            {
                                FullName = r.ContainsKey("full_name") && r["full_name"] != null ? r["full_name"].ToString() : "",
                                Name = r.ContainsKey("name") && r["name"] != null ? r["name"].ToString() : "",
                                HtmlUrl = r.ContainsKey("html_url") && r["html_url"] != null ? r["html_url"].ToString() : "",
                                CloneUrl = r.ContainsKey("clone_url") && r["clone_url"] != null ? r["clone_url"].ToString() : "",
                                DefaultBranch = r.ContainsKey("default_branch") && r["default_branch"] != null ? r["default_branch"].ToString() : "main",
                                IsPrivate = r.ContainsKey("private") && r["private"] is bool && (bool)r["private"],
                                Description = r.ContainsKey("description") && r["description"] != null ? r["description"].ToString() : ""
                            });
                        }
                    }

                    this.BeginInvoke(new Action(() =>
                    {
                        AuthenticatedUser = login;
                        AccessToken = tk;
                        allRepos = parsed;
                        lblAuthStatus.Text = string.Format("● 로그인 성공: @{0} (접근 가능한 저장소 {1}개 불러옴)", login, allRepos.Count);
                        lblAuthStatus.ForeColor = AccentGreen;
                        FilterRepoList();
                    }));
                }
                catch (Exception ex)
                {
                    this.BeginInvoke(new Action(() =>
                    {
                        lblAuthStatus.Text = "✖ 인증 실패: 토큰이 유효하지 않거나 네트워크 오류입니다.";
                        lblAuthStatus.ForeColor = Color.FromArgb(255, 110, 110);
                        MessageBox.Show("GitHub API 호출 실패:\n" + ex.Message, "인증 오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
        }

        private void FilterRepoList()
        {
            string q = txtSearch.Text.Trim().ToLowerInvariant();
            lvRepos.BeginUpdate();
            lvRepos.Items.Clear();
            foreach (var r in allRepos)
            {
                if (string.IsNullOrEmpty(q) || r.FullName.ToLowerInvariant().Contains(q))
                {
                    var item = new ListViewItem(r.FullName);
                    item.SubItems.Add(r.IsPrivate ? "[Private]" : "[Public]");
                    item.SubItems.Add(r.DefaultBranch);
                    item.SubItems.Add(r.HtmlUrl);
                    item.Tag = r;
                    lvRepos.Items.Add(item);
                }
            }
            lvRepos.EndUpdate();
        }

        private void ConfirmSelection()
        {
            if (lvRepos.SelectedItems.Count == 0) return;
            SelectedRepo = (GitHubRepoItem)lvRepos.SelectedItems[0].Tag;
            this.DialogResult = DialogResult.OK;
            this.Close();
        }
    }

    // =========================================================================
    // Main Application Window
    // =========================================================================
    public class MainForm : Form
    {
        private AppConfig config;
        private string configPath;

        // UI Controls - Header
        private Label lblStatusBadge;
        private Label lblCommitInfo;
        private Label lblTimer;
        private Button btnHeaderReset;

        // UI Controls - Left Panel & Tabs
        private Label lblConnectedRepo;
        private Button btnConnectGitHub;
        private ComboBox cboBranch;
        private Label lblLeftWfBadge;
        private Label lblPkgSummaryBadge;
        private ComboBox cboClientConfig;
        private ComboBox cboQualityPreset;
        private ComboBox cboResolution;
        private ComboBox cboWindowMode;
        private ComboBox cboDefaultFps;
        private CheckBox chkDefaultVSync;
        private CheckBox chkGenerateLauncher;
        private Button btnCreateLauncherManual;
        private Button btnRefreshBranches;
        private Label lblWorkflowStatus;
        private Button btnScanWorkflows;
        private Button btnPushWorkflow;
        private Button btnGitSync;
        private Button btnQuickVerify;
        private Button btnFullPackage;
        private Button btnStopBuild;

        // GitHub Actions Self-Hosted Runner Controls
        private Label lblRunnerStatus;
        private Button btnToggleApiPoller;
        private Button btnDownloadRunner;
        private Button btnRegisterRunner;
        private Button btnStartRunner;
        private Button btnStopRunner;
        private Button btnOpenGHActionsWeb;
        private CheckBox chkAutoSlack;
        private Process runnerProcess;
        private Timer apiPollTimer;
        private bool isApiPolling = false;
        private bool isPollChecking = false;
        private HashSet<string> processedRunOrCommitIds = new HashSet<string>();

        // Setup & Assets
        private Button btnInitFolders;
        private Button btnCloneRepo;
        private Button btnLinkAssets;
        private Label lblAssetStatus;

        // Main Tabs
        private TabControl tabMain;
        private TabPage tabConsolePage;
        private TabPage tabPackageOptsPage;
        private TabPage tabSetupPage;
        private TabPage tabHistoryPage;
        private TabPage tabSettingsPage;
        private RichTextBox rtbConsole;
        private RichTextBox rtbErrorsOnly;
        private SplitContainer splitConsole;
        private ListView lvHistory;

        // Settings Inputs
        private TextBox txtUE5Root;
        private TextBox txtWorkspaceRoot;
        private TextBox txtProjectDir;
        private TextBox txtSharedAssets;
        private TextBox txtArchiveRoot;
        private TextBox txtRunnerDir;
        private TextBox txtGitUrl;
        private TextBox txtGitHubApiToken;
        private TextBox txtRunnerToken;
        private TextBox txtSlackToken;
        private TextBox txtSlackChannel;
        private TextBox txtTailscaleIP;

        // Build Runtime State
        private Process activeProcess;
        private bool isBuilding = false;
        private DateTime buildStartTime;
        private Timer uiDurationTimer;
        private string currentLogFilePath = "";
        private string currentLogArchiveDir = "";
        private string currentBuildMode = "";
        private StringBuilder fullConsoleBuffer = new StringBuilder();

        // Colors (Modern Dark Theme)
        private readonly Color BgDark = Color.FromArgb(24, 26, 31);
        private readonly Color BgPanel = Color.FromArgb(33, 37, 43);
        private readonly Color BgInput = Color.FromArgb(44, 49, 58);
        private readonly Color FgText = Color.FromArgb(230, 234, 240);
        private readonly Color FgSub = Color.FromArgb(160, 170, 185);
        private readonly Color AccentBlue = Color.FromArgb(56, 132, 255);
        private readonly Color AccentGreen = Color.FromArgb(40, 180, 99);
        private readonly Color AccentOrange = Color.FromArgb(230, 126, 34);
        private readonly Color AccentRed = Color.FromArgb(220, 53, 69);
        private readonly Color AccentPurple = Color.FromArgb(130, 80, 223);

        public MainForm()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            configPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "build_manager_config.json");
            LoadConfig();
            InitializeUI();
            RefreshConnectedRepoState();
            CheckAssetLinksSilent();
            UpdateRunnerStatusUI();
            RefreshHistoryList();
            UpdateCommitBanner();
            if (!string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) && !string.IsNullOrWhiteSpace(config.GitHubAccessToken))
            {
                FetchBranchesViaGitHubApiAsync();
            }
        }

        public static string GitHubApiGet(string url, string token)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.UserAgent = "UE-BuildDeploy-Manager";
            req.Accept = "application/vnd.github+json";
            if (!string.IsNullOrWhiteSpace(token))
                req.Headers.Add("Authorization", "Bearer " + token);

            using (var resp = req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }

        public static string GitHubApiPost(string url, string token, string jsonBody = null)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.UserAgent = "UE-BuildDeploy-Manager";
            req.Accept = "application/vnd.github+json";
            if (!string.IsNullOrWhiteSpace(token))
                req.Headers.Add("Authorization", "Bearer " + token);

            if (!string.IsNullOrEmpty(jsonBody))
            {
                byte[] bodyBytes = Encoding.UTF8.GetBytes(jsonBody);
                req.ContentType = "application/json; charset=utf-8";
                req.ContentLength = bodyBytes.Length;
                using (var s = req.GetRequestStream()) s.Write(bodyBytes, 0, bodyBytes.Length);
            }
            else
            {
                req.ContentLength = 0;
            }

            using (var resp = req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }

        public static string GitHubApiPut(string url, string token, string jsonBody)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "PUT";
            req.UserAgent = "UE-BuildDeploy-Manager";
            req.Accept = "application/vnd.github+json";
            if (!string.IsNullOrWhiteSpace(token))
                req.Headers.Add("Authorization", "Bearer " + token);

            byte[] bodyBytes = Encoding.UTF8.GetBytes(jsonBody ?? "{}");
            req.ContentType = "application/json; charset=utf-8";
            req.ContentLength = bodyBytes.Length;
            using (var s = req.GetRequestStream()) s.Write(bodyBytes, 0, bodyBytes.Length);

            using (var resp = req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }

        private void LoadConfig()
        {
            try
            {
                if (File.Exists(configPath))
                {
                    byte[] raw = File.ReadAllBytes(configPath);
                    string json = EncodingHelper.DecodeSmartBytes(raw, raw.Length);
                    config = new JavaScriptSerializer().Deserialize<AppConfig>(json) ?? new AppConfig();
                    if (string.IsNullOrWhiteSpace(config.ClientConfig))
                        config.ClientConfig = "Development";
                    if (string.IsNullOrWhiteSpace(config.DefaultQualityPreset))
                        config.DefaultQualityPreset = "Epic";
                    if (string.IsNullOrWhiteSpace(config.DefaultResolution))
                        config.DefaultResolution = "1920x1080";
                    if (string.IsNullOrWhiteSpace(config.DefaultWindowMode))
                        config.DefaultWindowMode = "WindowedFullscreen";
                }
                else
                {
                    config = new AppConfig();
                }
            }
            catch
            {
                config = new AppConfig();
            }
        }

        private void SaveConfigFromUI()
        {
            if (txtUE5Root != null)
            {
                config.UE5Root = txtUE5Root.Text.Trim();
                config.WorkspaceRoot = txtWorkspaceRoot.Text.Trim();
                config.ProjectDir = txtProjectDir.Text.Trim();
                config.SharedAssetsDir = txtSharedAssets.Text.Trim();
                config.ArchiveRoot = txtArchiveRoot.Text.Trim();
                config.RunnerDir = txtRunnerDir.Text.Trim();
                config.GitRemoteUrl = txtGitUrl.Text.Trim();
                config.GitHubRepoUrl = config.GitRemoteUrl.EndsWith(".git")
                    ? config.GitRemoteUrl.Substring(0, config.GitRemoteUrl.Length - 4)
                    : config.GitRemoteUrl;

                // GitRemoteUrl에서 owner/repo 자동 추출 (예: 500pebbles/ProjectSW)
                if (!string.IsNullOrWhiteSpace(config.GitHubRepoUrl))
                {
                    var mRepo = Regex.Match(config.GitHubRepoUrl, @"github\.com[:/]([^/]+/[^/]+?)(?:\.git)?/?$", RegexOptions.IgnoreCase);
                    if (mRepo.Success)
                        config.ConnectedRepoFullName = mRepo.Groups[1].Value;
                }

                if (txtGitHubApiToken != null)
                    config.GitHubAccessToken = txtGitHubApiToken.Text.Trim();

                config.RunnerToken = txtRunnerToken.Text.Trim();
                config.SlackBotToken = txtSlackToken.Text.Trim();
                config.SlackChannelId = txtSlackChannel.Text.Trim();
                config.TailscaleIP = txtTailscaleIP.Text.Trim();
                config.LastBranch = cboBranch.Text.Trim();
                if (cboClientConfig != null)
                    config.ClientConfig = GetSelectedClientConfig();
                if (cboQualityPreset != null)
                    config.DefaultQualityPreset = GetSelectedQualityPresetName();
                if (cboResolution != null && !string.IsNullOrWhiteSpace(cboResolution.Text))
                    config.DefaultResolution = cboResolution.Text.Trim();
                if (cboWindowMode != null)
                    config.DefaultWindowMode = GetSelectedWindowModeName();
                if (cboDefaultFps != null)
                    config.DefaultFrameRateLimit = GetSelectedDefaultFps();
                if (chkDefaultVSync != null)
                    config.DefaultVSync = chkDefaultVSync.Checked;
                if (chkGenerateLauncher != null)
                    config.GenerateLauncherOnPackage = chkGenerateLauncher.Checked;
                config.AutoSendSlack = chkAutoSlack.Checked;
                RefreshPackageSummaryBadge();
            }
            try
            {
                var json = new JavaScriptSerializer().Serialize(config);
                File.WriteAllText(configPath, json, EncodingHelper.Utf8WithBom);
                if (Directory.Exists(@"C:\BuildSystem\Scripts"))
                {
                    File.WriteAllText(@"C:\BuildSystem\Scripts\build_manager_config.json", json, EncodingHelper.Utf8WithBom);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("설정 저장 실패: " + ex.Message, "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void FactoryResetForDistribution()
        {
            var res = MessageBox.Show(
                "배포용 초기화를 진행하시겠습니까?\n\n" +
                "- 연결된 GitHub 계정 및 저장소 정보\n" +
                "- 저장된 모든 토큰 (GitHub / Runner / Slack)\n" +
                "- 브랜치 목록 및 로컬 설정 파일(build_manager_config.json)\n\n" +
                "위 항목들이 모두 삭제되어 처음 배포받았을 때의 깨끗한 초기 상태로 돌아갑니다.",
                "배포용 데이터 전체 초기화",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (res != DialogResult.Yes) return;

            try
            {
                if (File.Exists(configPath)) File.Delete(configPath);
                if (File.Exists(@"C:\BuildSystem\Scripts\build_manager_config.json"))
                    File.Delete(@"C:\BuildSystem\Scripts\build_manager_config.json");
            }
            catch { }

            config = new AppConfig();

            txtUE5Root.Text = config.UE5Root;
            txtWorkspaceRoot.Text = config.WorkspaceRoot;
            txtProjectDir.Text = "";
            txtSharedAssets.Text = config.SharedAssetsDir;
            txtArchiveRoot.Text = config.ArchiveRoot;
            txtRunnerDir.Text = config.RunnerDir;
            txtGitUrl.Text = "";
            if (txtGitHubApiToken != null) txtGitHubApiToken.Text = "";
            txtRunnerToken.Text = "";
            txtSlackToken.Text = "";
            txtSlackChannel.Text = "";
            txtTailscaleIP.Text = "";

            if (isApiPolling) ToggleApiAutoPoller();

            cboBranch.Items.Clear();
            cboBranch.Text = "";
            if (cboClientConfig != null && cboClientConfig.Items.Count > 0)
                cboClientConfig.SelectedIndex = 0;
            if (cboQualityPreset != null && cboQualityPreset.Items.Count > 3)
                cboQualityPreset.SelectedIndex = 3;
            if (cboResolution != null && cboResolution.Items.Count > 2)
                cboResolution.SelectedIndex = 2;
            if (cboWindowMode != null && cboWindowMode.Items.Count > 0)
                cboWindowMode.SelectedIndex = 0;
            if (cboDefaultFps != null && cboDefaultFps.Items.Count > 0)
                cboDefaultFps.SelectedIndex = 0;
            if (chkDefaultVSync != null)
                chkDefaultVSync.Checked = true;
            if (chkGenerateLauncher != null)
                chkGenerateLauncher.Checked = true;
            RefreshPackageSummaryBadge();

            rtbConsole.Clear();
            rtbErrorsOnly.Clear();
            fullConsoleBuffer.Clear();

            RefreshConnectedRepoState();
            UpdateCommitBanner();
            CheckAssetLinksSilent();
            UpdateRunnerStatusUI();

            AppendConsole("✔ [초기화 완료] 모든 사용자 데이터와 설정이 초기화되어 깨끗한 배포 상태가 되었습니다.", AccentGreen);
            MessageBox.Show("모든 설정과 잔여 데이터가 초기화되었습니다.\n이제 이 폴더 그대로 다른 PC나 팀원에게 배포하셔도 데이터가 남아있지 않습니다.", "초기화 완료", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void InitializeUI()
        {
            this.Text = "Unreal Engine 전용 빌드 & GitHub Actions 자동 배포 매니저";
            this.Size = new Size(1380, 900);
            this.MinimumSize = new Size(1140, 760);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = BgDark;
            this.ForeColor = FgText;
            this.Font = new Font("Malgun Gothic", 9.5f, FontStyle.Regular);

            // Top Status Bar
            Panel pnlTop = new Panel
            {
                Dock = DockStyle.Top,
                Height = 56,
                BackColor = Color.FromArgb(18, 20, 24),
                Padding = new Padding(14, 10, 14, 10)
            };

            lblStatusBadge = new Label
            {
                Text = " ● 대기 중 (IDLE) ",
                AutoSize = true,
                BackColor = Color.FromArgb(52, 58, 64),
                ForeColor = Color.White,
                Font = new Font("Malgun Gothic", 10.5f, FontStyle.Bold),
                Padding = new Padding(8, 6, 8, 6),
                Location = new Point(14, 11)
            };

            lblCommitInfo = new Label
            {
                Text = "연결된 저장소 없음 — 좌측 [▶ GitHub 저장소 연결 / 변경]을 눌러 시작하세요.",
                AutoSize = true,
                ForeColor = FgSub,
                Font = new Font("Malgun Gothic", 9.5f, FontStyle.Regular),
                Location = new Point(205, 18)
            };

            btnHeaderReset = CreateFlatButton("[초기화] 배포용 데이터 비우기", new Point(1000, 12), new Size(195, 32), Color.FromArgb(55, 40, 45));
            btnHeaderReset.Dock = DockStyle.Right;
            btnHeaderReset.Click += (s, e) => FactoryResetForDistribution();

            lblTimer = new Label
            {
                Text = "소요 시간: 00분 00초  ",
                AutoSize = true,
                ForeColor = Color.FromArgb(255, 205, 86),
                Font = new Font("Malgun Gothic", 10.5f, FontStyle.Bold),
                Dock = DockStyle.Right,
                Padding = new Padding(0, 8, 12, 0)
            };

            pnlTop.Controls.Add(lblStatusBadge);
            pnlTop.Controls.Add(lblCommitInfo);
            pnlTop.Controls.Add(lblTimer);
            pnlTop.Controls.Add(btnHeaderReset);

            // Left Control Sidebar (Clean, Zero-Clutter Quick Launch Dashboard)
            Panel pnlLeft = new Panel
            {
                Dock = DockStyle.Left,
                Width = 358,
                BackColor = Color.FromArgb(20, 22, 27),
                Padding = new Padding(12),
                AutoScroll = true
            };

            int y = 10;
            int cardW = 332;

            // --- Card 1: Repository & Branch ---
            Panel cardRepo = CreateCardPanel("■ 1. 연결 저장소 & 브랜치", new Point(12, y), new Size(cardW, 198));
            int cy = 34;

            lblConnectedRepo = new Label
            {
                Text = "○ 연결된 저장소: 없음 (연결 필요)",
                Location = new Point(12, cy),
                Size = new Size(cardW - 24, 20),
                ForeColor = Color.FromArgb(255, 205, 86),
                Font = new Font("Malgun Gothic", 8.8f, FontStyle.Bold)
            };
            cardRepo.Controls.Add(lblConnectedRepo);
            cy += 23;

            btnConnectGitHub = CreateFlatButton("▶ GitHub 저장소 연결 / 변경", new Point(12, cy), new Size(cardW - 24, 34), AccentPurple);
            btnConnectGitHub.Font = new Font("Malgun Gothic", 9.2f, FontStyle.Bold);
            btnConnectGitHub.Click += (s, e) => OpenGitHubConnectDialog();
            cardRepo.Controls.Add(btnConnectGitHub);
            cy += 42;

            Label lblBr = new Label { Text = "브랜치:", Location = new Point(12, cy + 4), AutoSize = true, ForeColor = FgSub };
            cboBranch = new ComboBox
            {
                Location = new Point(66, cy),
                Width = 178,
                BackColor = BgInput,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Text = config.LastBranch
            };
            cboBranch.SelectedIndexChanged += (s, e) =>
            {
                CheckSelectedBranchWorkflowAsync(cboBranch.Text.Trim());
                UpdateCommitBanner();
            };

            btnRefreshBranches = CreateFlatButton("↻ 갱신", new Point(250, cy - 1), new Size(70, 27), BgInput);
            btnRefreshBranches.Click += (s, e) => FetchBranchList();

            cardRepo.Controls.Add(lblBr);
            cardRepo.Controls.Add(cboBranch);
            cardRepo.Controls.Add(btnRefreshBranches);
            cy += 30;

            lblLeftWfBadge = new Label
            {
                Text = "○ 워크플로우 상태: [3] 탭에서 스캔/등록 가능",
                Location = new Point(12, cy),
                Size = new Size(cardW - 24, 19),
                ForeColor = FgSub,
                Font = new Font("Malgun Gothic", 8.2f, FontStyle.Regular),
                Cursor = Cursors.Hand
            };
            lblLeftWfBadge.Click += (s, e) => { if (tabSetupPage != null) tabMain.SelectedTab = tabSetupPage; };
            cardRepo.Controls.Add(lblLeftWfBadge);
            cy += 22;

            btnGitSync = CreateFlatButton("▼ 선택 브랜치 최신 커밋 동기화 (Git Sync)", new Point(12, cy), new Size(cardW - 24, 33), Color.FromArgb(54, 62, 76));
            btnGitSync.Click += async (s, e) => await RunGitSyncAsync(cboBranch.Text.Trim());
            cardRepo.Controls.Add(btnGitSync);

            pnlLeft.Controls.Add(cardRepo);
            y += cardRepo.Height + 12;

            // --- Card 2: One-Click Build & Package ---
            Panel cardBuild = CreateCardPanel("■ 2. 원클릭 빌드 & 패키징 실행", new Point(12, y), new Size(cardW, 212));
            cy = 34;

            Panel pnlOptSummary = new Panel
            {
                Location = new Point(12, cy),
                Size = new Size(cardW - 24, 32),
                BackColor = Color.FromArgb(24, 28, 36)
            };
            lblPkgSummaryBadge = new Label
            {
                Text = "옵션: Development · Epic · 1920x1080",
                Location = new Point(8, 7),
                Size = new Size(210, 18),
                ForeColor = Color.FromArgb(145, 225, 175),
                Font = new Font("Malgun Gothic", 8.3f, FontStyle.Bold)
            };
            Button btnGoPkgOpts = CreateFlatButton("옵션 변경 →", new Point(cardW - 112, 3), new Size(84, 26), Color.FromArgb(52, 60, 76));
            btnGoPkgOpts.Font = new Font("Malgun Gothic", 8.2f, FontStyle.Bold);
            btnGoPkgOpts.Click += (s, e) => { if (tabPackageOptsPage != null) tabMain.SelectedTab = tabPackageOptsPage; };
            pnlOptSummary.Controls.Add(lblPkgSummaryBadge);
            pnlOptSummary.Controls.Add(btnGoPkgOpts);
            cardBuild.Controls.Add(pnlOptSummary);
            cy += 40;

            btnQuickVerify = CreateFlatButton("▶ 빠른 검증 빌드 (컴파일 + 증분 쿠킹)", new Point(12, cy), new Size(cardW - 24, 42), AccentGreen);
            btnQuickVerify.Font = new Font("Malgun Gothic", 9.8f, FontStyle.Bold);
            btnQuickVerify.Click += (s, e) => StartUEBuild("QuickVerify", cboBranch.Text.Trim());
            cardBuild.Controls.Add(btnQuickVerify);
            cy += 48;

            btnFullPackage = CreateFlatButton("★ 전체 패키징 빌드 (.pak + 런처 동봉)", new Point(12, cy), new Size(cardW - 24, 42), AccentBlue);
            btnFullPackage.Font = new Font("Malgun Gothic", 9.8f, FontStyle.Bold);
            btnFullPackage.Click += (s, e) => StartUEBuild("FullPackage", cboBranch.Text.Trim());
            cardBuild.Controls.Add(btnFullPackage);
            cy += 48;

            btnStopBuild = CreateFlatButton("■ 진행 중인 빌드 강제 중단", new Point(12, cy), new Size(cardW - 24, 28), AccentRed);
            btnStopBuild.Enabled = false;
            btnStopBuild.Click += (s, e) => StopActiveBuild();
            cardBuild.Controls.Add(btnStopBuild);

            pnlLeft.Controls.Add(cardBuild);
            y += cardBuild.Height + 12;

            // --- Card 3: Auto-Watch Builder & Slack ---
            Panel cardAuto = CreateCardPanel("■ 3. 무인 자동 감지 빌더 & 알림", new Point(12, y), new Size(cardW, 132));
            cy = 34;

            lblRunnerStatus = new Label
            {
                Text = "● 상태: 확인 중...",
                Location = new Point(12, cy),
                Size = new Size(cardW - 24, 20),
                ForeColor = Color.FromArgb(255, 205, 86),
                Font = new Font("Malgun Gothic", 8.8f, FontStyle.Bold)
            };
            cardAuto.Controls.Add(lblRunnerStatus);
            cy += 24;

            btnToggleApiPoller = CreateFlatButton("★ API 자동 감지 빌더 가동 (방장권한 불필요)", new Point(12, cy), new Size(cardW - 24, 38), AccentGreen);
            btnToggleApiPoller.Font = new Font("Malgun Gothic", 9.2f, FontStyle.Bold);
            btnToggleApiPoller.Click += (s, e) => ToggleApiAutoPoller();
            cardAuto.Controls.Add(btnToggleApiPoller);
            cy += 44;

            chkAutoSlack = new CheckBox
            {
                Text = "빌드 완료/에러 시 Slack 채널로 자동 리포트",
                Location = new Point(14, cy),
                AutoSize = true,
                Checked = config.AutoSendSlack,
                ForeColor = FgText,
                Font = new Font("Malgun Gothic", 8.8f)
            };
            chkAutoSlack.CheckedChanged += (s, e) => SaveConfigFromUI();
            cardAuto.Controls.Add(chkAutoSlack);

            pnlLeft.Controls.Add(cardAuto);
            y += cardAuto.Height + 12;

            // --- Card 4: Quick Archive Folders ---
            Button btnOpenLogs = CreateFlatButton("로그 보관함 열기", new Point(12, y), new Size(162, 34), BgPanel);
            btnOpenLogs.Click += (s, e) => OpenFolderSafe(Path.Combine(config.ArchiveRoot, "Logs"));
            Button btnOpenPkgs = CreateFlatButton("패키징 폴더 열기", new Point(182, y), new Size(162, 34), BgPanel);
            btnOpenPkgs.Click += (s, e) => OpenFolderSafe(Path.Combine(config.ArchiveRoot, "Packages"));
            pnlLeft.Controls.Add(btnOpenLogs);
            pnlLeft.Controls.Add(btnOpenPkgs);

            // =================================================================
            // Right Main Content Area (5 Organized Tabs)
            // =================================================================
            tabMain = new TabControl
            {
                Dock = DockStyle.Fill,
                Font = new Font("Malgun Gothic", 10f, FontStyle.Regular)
            };

            // Tab 1: Live Console & Error Extractor
            tabConsolePage = new TabPage("[1] 실시간 빌드 로그")
            {
                BackColor = BgDark,
                Padding = new Padding(8)
            };

            Panel pnlConsoleToolbar = new Panel
            {
                Dock = DockStyle.Top,
                Height = 42,
                BackColor = BgPanel,
                Padding = new Padding(6)
            };

            Button btnExtractErrors = CreateFlatButton("현재 로그에서 에러(Error)만 추출", new Point(8, 5), new Size(235, 31), AccentOrange);
            btnExtractErrors.Click += (s, e) => ExtractAndShowErrors();

            Button btnManualSlack = CreateFlatButton("현재 빌드 로그 Slack으로 즉시 전송", new Point(250, 5), new Size(250, 31), AccentBlue);
            btnManualSlack.Click += async (s, e) => await SendSlackReportManualAsync();

            Button btnOpenCurrentLog = CreateFlatButton("현재 로그 메모장으로 열기", new Point(507, 5), new Size(195, 31), BgInput);
            btnOpenCurrentLog.Click += (s, e) =>
            {
                if (!string.IsNullOrEmpty(currentLogFilePath) && File.Exists(currentLogFilePath))
                    Process.Start("notepad.exe", currentLogFilePath);
                else
                    MessageBox.Show("아직 생성된 빌드 로그 파일이 없습니다.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };

            Button btnClearConsole = CreateFlatButton("화면 지우기", new Point(709, 5), new Size(115, 31), BgInput);
            btnClearConsole.Click += (s, e) =>
            {
                rtbConsole.Clear();
                rtbErrorsOnly.Clear();
                fullConsoleBuffer.Clear();
            };

            pnlConsoleToolbar.Controls.AddRange(new Control[] { btnExtractErrors, btnManualSlack, btnOpenCurrentLog, btnClearConsole });

            splitConsole = new SplitContainer
            {
                Dock = DockStyle.Fill,
                Orientation = Orientation.Horizontal,
                SplitterDistance = 480,
                BackColor = BgPanel
            };

            rtbConsole = new RichTextBox
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(16, 18, 22),
                ForeColor = Color.FromArgb(220, 225, 232),
                Font = new Font("Malgun Gothic", 9.5f),
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                WordWrap = false
            };

            Panel pnlErrorHeader = new Panel
            {
                Dock = DockStyle.Top,
                Height = 26,
                BackColor = Color.FromArgb(45, 22, 28)
            };
            Label lblErrTitle = new Label
            {
                Text = " [!] 핵심 에러 / 경고 발췌 뷰어 (C++ 컴파일 에러, 쿠킹 에러, 플러그인 누락 자동 필터링)",
                AutoSize = true,
                ForeColor = Color.FromArgb(255, 150, 150),
                Font = new Font("Malgun Gothic", 9f, FontStyle.Bold),
                Location = new Point(6, 4)
            };
            pnlErrorHeader.Controls.Add(lblErrTitle);

            rtbErrorsOnly = new RichTextBox
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(24, 16, 18),
                ForeColor = Color.FromArgb(255, 180, 180),
                Font = new Font("Malgun Gothic", 9.5f),
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                WordWrap = false
            };

            splitConsole.Panel1.Controls.Add(rtbConsole);
            splitConsole.Panel2.Controls.Add(rtbErrorsOnly);
            splitConsole.Panel2.Controls.Add(pnlErrorHeader);

            tabConsolePage.Controls.Add(splitConsole);
            tabConsolePage.Controls.Add(pnlConsoleToolbar);

            // Tab 2: Packaging & Game Launch Options
            tabPackageOptsPage = new TabPage("[2] 패키징 & 게임 옵션")
            {
                BackColor = BgDark,
                Padding = new Padding(16),
                AutoScroll = true
            };
            BuildPackageOptionsTab(tabPackageOptsPage);

            // Tab 3: Branch Workflow & Initial PC Setup
            tabSetupPage = new TabPage("[3] 워크플로우 & 초기 세팅")
            {
                BackColor = BgDark,
                Padding = new Padding(16),
                AutoScroll = true
            };
            BuildWorkflowAndSetupTab(tabSetupPage);

            // Tab 4: Build Log History
            tabHistoryPage = new TabPage("[4] 빌드 히스토리")
            {
                BackColor = BgDark,
                Padding = new Padding(8)
            };

            Panel pnlHistTop = new Panel { Dock = DockStyle.Top, Height = 42, BackColor = BgPanel };
            Button btnRefreshHist = CreateFlatButton("↻ 히스토리 새로고침", new Point(8, 5), new Size(160, 31), BgInput);
            btnRefreshHist.Click += (s, e) => RefreshHistoryList();

            Button btnViewHistLog = CreateFlatButton("선택한 빌드의 전체 로그 열기", new Point(176, 5), new Size(220, 31), AccentBlue);
            btnViewHistLog.Click += (s, e) => OpenSelectedHistoryLog(false);

            Button btnViewHistErr = CreateFlatButton("선택한 빌드의 에러 요약 열기", new Point(404, 5), new Size(220, 31), AccentOrange);
            btnViewHistErr.Click += (s, e) => OpenSelectedHistoryLog(true);

            Button btnOpenHistDir = CreateFlatButton("해당 로그 폴더 열기", new Point(632, 5), new Size(175, 31), BgInput);
            btnOpenHistDir.Click += (s, e) =>
            {
                if (lvHistory.SelectedItems.Count > 0)
                    OpenFolderSafe(lvHistory.SelectedItems[0].Tag.ToString());
            };

            pnlHistTop.Controls.AddRange(new Control[] { btnRefreshHist, btnViewHistLog, btnViewHistErr, btnOpenHistDir });

            lvHistory = new ListView
            {
                Dock = DockStyle.Fill,
                View = View.Details,
                FullRowSelect = true,
                GridLines = true,
                BackColor = Color.FromArgb(20, 22, 27),
                ForeColor = FgText,
                BorderStyle = BorderStyle.None
            };
            lvHistory.Columns.Add("빌드 일시 / 폴더명", 320);
            lvHistory.Columns.Add("모드", 120);
            lvHistory.Columns.Add("생성 시각", 180);
            lvHistory.Columns.Add("에러 요약 유무", 130);
            lvHistory.Columns.Add("전체 경로", 340);
            lvHistory.DoubleClick += (s, e) => OpenSelectedHistoryLog(false);

            tabHistoryPage.Controls.Add(lvHistory);
            tabHistoryPage.Controls.Add(pnlHistTop);

            // Tab 5: Settings & GitHub / Slack Tokens
            tabSettingsPage = new TabPage("[5] 경로 & 토큰 설정")
            {
                BackColor = BgDark,
                Padding = new Padding(16),
                AutoScroll = true
            };
            BuildSettingsTab(tabSettingsPage);

            tabMain.TabPages.Add(tabConsolePage);
            tabMain.TabPages.Add(tabPackageOptsPage);
            tabMain.TabPages.Add(tabSetupPage);
            tabMain.TabPages.Add(tabHistoryPage);
            tabMain.TabPages.Add(tabSettingsPage);

            this.Controls.Add(tabMain);
            this.Controls.Add(pnlLeft);
            this.Controls.Add(pnlTop);

            RefreshPackageSummaryBadge();

            uiDurationTimer = new Timer { Interval = 1000 };
            uiDurationTimer.Tick += (s, e) =>
            {
                if (isBuilding)
                {
                    var elapsed = DateTime.Now - buildStartTime;
                    lblTimer.Text = string.Format("소요 시간: {0:D2}분 {1:D2}초  ", (int)elapsed.TotalMinutes, elapsed.Seconds);
                }
            };

            AppendConsole("=== Unreal Engine 전용 빌드 & GitHub Actions 자동 배포 매니저 ===", Color.Cyan);
            AppendConsole("1. 좌측 [1. 연결 저장소 & 브랜치]에서 저장소를 선택하고, [3. 무인 자동 감지 빌더]를 가동하면 모든 Push가 자동 빌드됩니다.", FgSub);
            AppendConsole("2. 패키징 구성(Development/Shipping), 그래픽 프리셋, 해상도 및 런처 동봉 설정은 상단 [[2] 패키징 & 게임 옵션] 탭에서 조정할 수 있습니다.", FgSub);
            AppendConsole("3. 최초 폴더 생성, Clone, .gitignore 에셋 연결, build.yml 등록은 상단 [[3] 워크플로우 & 초기 세팅] 탭에 깔끔하게 모아두었습니다.\n", FgSub);
        }

        private Panel CreateCardPanel(string title, Point loc, Size size)
        {
            Panel card = new Panel
            {
                Location = loc,
                Size = size,
                BackColor = BgPanel,
                BorderStyle = BorderStyle.FixedSingle
            };
            Label lbl = new Label
            {
                Text = title,
                Location = new Point(12, 9),
                AutoSize = true,
                ForeColor = Color.FromArgb(130, 195, 255),
                Font = new Font("Malgun Gothic", 9.6f, FontStyle.Bold)
            };
            card.Controls.Add(lbl);
            return card;
        }

        private void RefreshPackageSummaryBadge()
        {
            if (lblPkgSummaryBadge == null) return;
            string cfg = GetSelectedClientConfig();
            string preset = GetSelectedQualityPresetName();
            string res = (cboResolution != null && !string.IsNullOrWhiteSpace(cboResolution.Text)) ? cboResolution.Text.Trim() : config.DefaultResolution;
            string lnch = (chkGenerateLauncher == null || chkGenerateLauncher.Checked) ? "런처ON" : "런처OFF";
            lblPkgSummaryBadge.Text = string.Format("{0} · {1} · {2} · {3}", cfg, preset, res, lnch);
        }

        private void BuildPackageOptionsTab(TabPage page)
        {
            int y = 14;
            int cardW = 860;

            // Card 1: Packaging Configuration
            Panel cardCfg = CreateCardPanel("■ 1. 언리얼 패키징 빌드 구성 (Client Build Configuration)", new Point(16, y), new Size(cardW, 118));
            Label lblCfg = new Label { Text = "패키징 구성 선택:", Location = new Point(18, 44), AutoSize = true, ForeColor = FgSub };
            cboClientConfig = new ComboBox
            {
                Location = new Point(195, 40),
                Width = 380,
                BackColor = BgInput,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            cboClientConfig.Items.AddRange(new object[]
            {
                "Development (개발/콘솔 명령어/로그 포함 — 기본 권장)",
                "Shipping (최종 배포/외부 제출용 — 디버그 제거 및 최대 최적화)",
                "DebugGame (C++ 심층 디버깅 전용)"
            });
            if (string.Equals(config.ClientConfig, "Shipping", StringComparison.OrdinalIgnoreCase))
                cboClientConfig.SelectedIndex = 1;
            else if (string.Equals(config.ClientConfig, "DebugGame", StringComparison.OrdinalIgnoreCase))
                cboClientConfig.SelectedIndex = 2;
            else
                cboClientConfig.SelectedIndex = 0;

            Label lblCfgHint = new Label
            {
                Location = new Point(195, 76),
                Size = new Size(640, 28),
                ForeColor = Color.FromArgb(145, 210, 255),
                Font = new Font("Malgun Gothic", 8.8f)
            };
            Action updateCfgHint = () =>
            {
                if (cboClientConfig.SelectedIndex == 1)
                    lblCfgHint.Text = "▶ Shipping: 콘솔 키(~)와 Print String이 비활성화되고 실행 성능과 용량이 최대 최적화됩니다.";
                else if (cboClientConfig.SelectedIndex == 2)
                    lblCfgHint.Text = "▶ DebugGame: 엔진은 최적화 상태로 두고 프로젝트 C++ 모듈만 디버그 심볼을 유지합니다.";
                else
                    lblCfgHint.Text = "▶ Development: 콘솔 명령어(~), 디버그 출력, 상세 크래시 로그가 활성화되어 팀 테스트에 가장 적합합니다.";
            };
            updateCfgHint();
            cboClientConfig.SelectedIndexChanged += (s, e) => { updateCfgHint(); SaveConfigFromUI(); };

            cardCfg.Controls.AddRange(new Control[] { lblCfg, cboClientConfig, lblCfgHint });
            page.Controls.Add(cardCfg);
            y += cardCfg.Height + 16;

            // Card 2: Default Graphics & Display Preset
            Panel cardGfx = CreateCardPanel("■ 2. 패키징 기본 그래픽 프리셋 & 디스플레이 설정 (DefaultGameUserSettings)", new Point(16, y), new Size(cardW, 252));
            Label lblGfxSub = new Label
            {
                Text = "전체 패키징(.pak) 시 아래 기본값이 게임에 구워지며, 동봉되는 런처의 초기 선택값으로도 설정됩니다.",
                Location = new Point(18, 36),
                AutoSize = true,
                ForeColor = FgSub,
                Font = new Font("Malgun Gothic", 8.8f)
            };
            cardGfx.Controls.Add(lblGfxSub);

            int gy = 68;
            Label lblPreset = new Label { Text = "언리얼 그래픽 프리셋:", Location = new Point(18, gy + 4), AutoSize = true, ForeColor = FgSub };
            cboQualityPreset = new ComboBox
            {
                Location = new Point(195, gy),
                Width = 380,
                BackColor = BgInput,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            cboQualityPreset.Items.AddRange(new object[]
            {
                "Low (낮음 — 최고 프레임 / 내장·저사양 PC)",
                "Medium (중간 — 발열 감소 / 밸런스 옵션)",
                "High (높음 — 고품질 라이팅 & 그림자)",
                "Epic (에픽 — 언리얼 엔진 기본 최고 품질)",
                "Cinematic (시네마틱 — 영상 촬영·시연용 극한 품질)"
            });
            cboQualityPreset.SelectedIndex = GameLauncherBuilder.PresetNameToIndex(config.DefaultQualityPreset);
            cboQualityPreset.SelectedIndexChanged += (s, e) => SaveConfigFromUI();
            cardGfx.Controls.AddRange(new Control[] { lblPreset, cboQualityPreset });
            gy += 38;

            Label lblRes = new Label { Text = "기본 화면 해상도:", Location = new Point(18, gy + 4), AutoSize = true, ForeColor = FgSub };
            cboResolution = new ComboBox
            {
                Location = new Point(195, gy),
                Width = 210,
                BackColor = BgInput,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            string[] stdRes = new[] { "1280x720", "1600x900", "1920x1080", "2560x1440", "3840x2160" };
            cboResolution.Items.AddRange(stdRes);
            int resIdx = Array.IndexOf(stdRes, config.DefaultResolution);
            cboResolution.SelectedIndex = resIdx >= 0 ? resIdx : 2;
            cboResolution.SelectedIndexChanged += (s, e) => SaveConfigFromUI();

            Label lblWinMode = new Label { Text = "화면 표시 모드:", Location = new Point(430, gy + 4), AutoSize = true, ForeColor = FgSub };
            cboWindowMode = new ComboBox
            {
                Location = new Point(545, gy),
                Width = 280,
                BackColor = BgInput,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            cboWindowMode.Items.AddRange(new object[]
            {
                "테두리 없는 전체 창 (Windowed Fullscreen)",
                "전체 화면 (Exclusive Fullscreen)",
                "창 모드 (Windowed)"
            });
            if (string.Equals(config.DefaultWindowMode, "Fullscreen", StringComparison.OrdinalIgnoreCase))
                cboWindowMode.SelectedIndex = 1;
            else if (string.Equals(config.DefaultWindowMode, "Windowed", StringComparison.OrdinalIgnoreCase))
                cboWindowMode.SelectedIndex = 2;
            else
                cboWindowMode.SelectedIndex = 0;
            cboWindowMode.SelectedIndexChanged += (s, e) => SaveConfigFromUI();

            cardGfx.Controls.AddRange(new Control[] { lblRes, cboResolution, lblWinMode, cboWindowMode });
            gy += 38;

            Label lblFps = new Label { Text = "기본 최대 프레임 제한:", Location = new Point(18, gy + 4), AutoSize = true, ForeColor = FgSub };
            cboDefaultFps = new ComboBox
            {
                Location = new Point(195, gy),
                Width = 210,
                BackColor = BgInput,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                DropDownStyle = ComboBoxStyle.DropDownList
            };
            cboDefaultFps.Items.AddRange(new object[]
            {
                "무제한 (Unlimited)",
                "30 FPS",
                "60 FPS",
                "120 FPS",
                "144 FPS"
            });
            if (config.DefaultFrameRateLimit == 30) cboDefaultFps.SelectedIndex = 1;
            else if (config.DefaultFrameRateLimit == 60) cboDefaultFps.SelectedIndex = 2;
            else if (config.DefaultFrameRateLimit == 120) cboDefaultFps.SelectedIndex = 3;
            else if (config.DefaultFrameRateLimit == 144) cboDefaultFps.SelectedIndex = 4;
            else cboDefaultFps.SelectedIndex = 0;
            cboDefaultFps.SelectedIndexChanged += (s, e) => SaveConfigFromUI();

            chkDefaultVSync = new CheckBox
            {
                Text = "수직동기화 (VSync) 기본 활성화",
                Location = new Point(432, gy + 2),
                AutoSize = true,
                Checked = config.DefaultVSync,
                ForeColor = FgText
            };
            chkDefaultVSync.CheckedChanged += (s, e) => SaveConfigFromUI();

            cardGfx.Controls.AddRange(new Control[] { lblFps, cboDefaultFps, chkDefaultVSync });
            gy += 42;

            Label lblPresetExplain = new Label
            {
                Text = "* 언리얼 Scalability 11개 그래픽 항목(루멘 GI, 리플렉션, 그림자, 안티앨리어싱, 텍스처, 이펙트, 식생 등)이 선택한 프리셋 단계로 자동 설정됩니다.",
                Location = new Point(18, gy),
                AutoSize = true,
                ForeColor = Color.FromArgb(145, 225, 175),
                Font = new Font("Malgun Gothic", 8.6f)
            };
            cardGfx.Controls.Add(lblPresetExplain);

            page.Controls.Add(cardGfx);
            y += cardGfx.Height + 16;

            // Card 3: Game Option Launcher Auto-Generator
            Panel cardLnch = CreateCardPanel("■ 3. 게임 실행 옵션 런처 ({프로젝트명}_Launcher.exe) 동봉 & 즉시 생성 도구", new Point(16, y), new Size(cardW, 156));

            chkGenerateLauncher = new CheckBox
            {
                Text = "전체 패키징 완료 시 결과물 폴더에 '게임 실행 옵션 선택 런처.exe' 자동 동봉 (권장)",
                Location = new Point(18, 40),
                AutoSize = true,
                Checked = config.GenerateLauncherOnPackage,
                ForeColor = Color.FromArgb(145, 225, 175),
                Font = new Font("Malgun Gothic", 9.6f, FontStyle.Bold)
            };
            chkGenerateLauncher.CheckedChanged += (s, e) => SaveConfigFromUI();

            Label lblLnchDesc = new Label
            {
                Text = "게임을 켤 때 그래픽 프리셋(낮음~시네마틱), 3D 렌더링 선명도, 해상도, 창 모드, FPS 제한을 고르고 실행할 수 있는 독립 런처를 동봉합니다.",
                Location = new Point(38, 68),
                AutoSize = true,
                ForeColor = FgSub,
                Font = new Font("Malgun Gothic", 8.8f)
            };

            btnCreateLauncherManual = CreateFlatButton("★ 이미 뽑아둔 기존 패키징 폴더에 '게임 옵션 런처.exe' 지금 바로 생성하기", new Point(18, 100), new Size(540, 38), AccentPurple);
            btnCreateLauncherManual.Font = new Font("Malgun Gothic", 9.5f, FontStyle.Bold);
            btnCreateLauncherManual.Click += (s, e) => CreateLauncherInExistingFolderDialog();

            Button btnOpenPkgDirFromTab = CreateFlatButton("패키징 결과물 보관함 열기", new Point(570, 100), new Size(260, 38), BgInput);
            btnOpenPkgDirFromTab.Click += (s, e) => OpenFolderSafe(Path.Combine(config.ArchiveRoot, "Packages"));

            cardLnch.Controls.AddRange(new Control[] { chkGenerateLauncher, lblLnchDesc, btnCreateLauncherManual, btnOpenPkgDirFromTab });
            page.Controls.Add(cardLnch);
        }

        private void BuildWorkflowAndSetupTab(TabPage page)
        {
            int y = 14;
            int cardW = 860;

            // Card 1: Initial PC Setup & Asset Junctions
            Panel cardSetup = CreateCardPanel("■ 1. 전용 빌드 PC 초기 폴더 구축 & .gitignore 제외 에셋 심볼릭 링크 연결", new Point(16, y), new Size(cardW, 152));

            lblAssetStatus = new Label
            {
                Text = "○ 에셋 링크 상태: 저장소 연결 후 확인 가능",
                Location = new Point(18, 38),
                Size = new Size(cardW - 36, 22),
                ForeColor = FgSub,
                Font = new Font("Malgun Gothic", 9.2f, FontStyle.Bold)
            };
            cardSetup.Controls.Add(lblAssetStatus);

            btnInitFolders = CreateFlatButton("[1] 필수 폴더 구조(BuildSystem/Archive) 생성", new Point(18, 68), new Size(268, 36), BgInput);
            btnInitFolders.Click += (s, e) => InitDirectories();

            btnCloneRepo = CreateFlatButton("[2] 연결된 저장소를 워크스페이스에 최초 Clone", new Point(296, 68), new Size(276, 36), BgInput);
            btnCloneRepo.Click += async (s, e) => await CloneRepositoryAsync();

            btnLinkAssets = CreateFlatButton("[3] .gitignore 제외 에셋 심볼릭 링크 연결", new Point(582, 68), new Size(258, 36), AccentOrange);
            btnLinkAssets.Font = new Font("Malgun Gothic", 9f, FontStyle.Bold);
            btnLinkAssets.Click += (s, e) => EnsureAssetJunctions(true);

            Button btnOpenShared = CreateFlatButton("제외 에셋 원본(SharedAssets) 폴더 열기", new Point(18, 110), new Size(268, 30), BgInput);
            btnOpenShared.Click += (s, e) => OpenFolderSafe(config.SharedAssetsDir);

            Button btnOpenWorkspace = CreateFlatButton("워크스페이스 프로젝트 폴더 열기", new Point(296, 110), new Size(276, 30), BgInput);
            btnOpenWorkspace.Click += (s, e) => OpenFolderSafe(string.IsNullOrWhiteSpace(config.ProjectDir) ? config.WorkspaceRoot : config.ProjectDir);

            cardSetup.Controls.AddRange(new Control[] { btnInitFolders, btnCloneRepo, btnLinkAssets, btnOpenShared, btnOpenWorkspace });
            page.Controls.Add(cardSetup);
            y += cardSetup.Height + 16;

            // Card 2: Branch Workflow (build.yml) Scanner & Auto-Push
            Panel cardWf = CreateCardPanel("■ 2. 브랜치별 GitHub Actions 워크플로우 (.github/workflows/build.yml) 관리", new Point(16, y), new Size(cardW, 138));

            lblWorkflowStatus = new Label
            {
                Text = "○ 브랜치 워크플로우(build.yml): 저장소 연결 후 자동 확인",
                Location = new Point(18, 38),
                Size = new Size(cardW - 36, 22),
                ForeColor = FgSub,
                Font = new Font("Malgun Gothic", 9.2f, FontStyle.Bold)
            };
            cardWf.Controls.Add(lblWorkflowStatus);

            btnScanWorkflows = CreateFlatButton("▶ 모든 원격 브랜치 build.yml 유무 & Actions 감지 스캔", new Point(18, 72), new Size(305, 40), Color.FromArgb(48, 72, 98));
            btnScanWorkflows.Click += async (s, e) => await ScanAllBranchesForWorkflowAsync(true);

            btnPushWorkflow = CreateFlatButton("★ 현재 선택된 브랜치에 build.yml 원클릭 자동 커밋(Push)", new Point(333, 72), new Size(325, 40), AccentPurple);
            btnPushWorkflow.Font = new Font("Malgun Gothic", 9f, FontStyle.Bold);
            btnPushWorkflow.Click += async (s, e) => await PushWorkflowToSelectedBranchAsync();

            btnOpenGHActionsWeb = CreateFlatButton("→ GitHub Actions 웹 열기", new Point(668, 72), new Size(172, 40), BgInput);
            btnOpenGHActionsWeb.Click += (s, e) =>
            {
                if (string.IsNullOrWhiteSpace(config.GitHubRepoUrl))
                {
                    MessageBox.Show("먼저 좌측 [GitHub 저장소 연결 / 변경]으로 저장소를 연결해 주세요.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Process.Start(config.GitHubRepoUrl + "/actions");
            };

            cardWf.Controls.AddRange(new Control[] { btnScanWorkflows, btnPushWorkflow, btnOpenGHActionsWeb });
            page.Controls.Add(cardWf);
            y += cardWf.Height + 16;

            // Card 3: Optional Official GitHub Self-Hosted Runner
            Panel cardRunner = CreateCardPanel("■ 3. 공식 GitHub Self-Hosted Runner 설치 및 제어 (저장소 방장/Owner 전용 · 선택 기능)", new Point(16, y), new Size(cardW, 132));
            Label lblRunnerNote = new Label
            {
                Text = "* 일반 팀원(Collaborator) 권한에서는 좌측 [★ API 자동 감지 빌더 가동]만 켜두시면 충분하므로 아래 Runner는 설치하지 않으셔도 됩니다.",
                Location = new Point(18, 38),
                AutoSize = true,
                ForeColor = Color.FromArgb(145, 210, 255),
                Font = new Font("Malgun Gothic", 8.8f)
            };
            cardRunner.Controls.Add(lblRunnerNote);

            btnDownloadRunner = CreateFlatButton("[1] Runner 다운로드 & 설치", new Point(18, 72), new Size(215, 38), BgInput);
            btnDownloadRunner.Click += async (s, e) => await DownloadAndExtractRunnerAsync();

            btnRegisterRunner = CreateFlatButton("[2] 이 PC를 공식 Runner로 등록", new Point(243, 72), new Size(235, 38), AccentPurple);
            btnRegisterRunner.Click += async (s, e) => await RegisterGitHubRunnerAsync();

            btnStartRunner = CreateFlatButton("▶ Runner 가동 시작", new Point(488, 72), new Size(170, 38), AccentGreen);
            btnStartRunner.Font = new Font("Malgun Gothic", 9.2f, FontStyle.Bold);
            btnStartRunner.Click += (s, e) => StartGitHubRunnerAgent();

            btnStopRunner = CreateFlatButton("■ Runner 중지", new Point(668, 72), new Size(172, 38), AccentRed);
            btnStopRunner.Enabled = false;
            btnStopRunner.Click += (s, e) => StopGitHubRunnerAgent();

            cardRunner.Controls.AddRange(new Control[] { btnDownloadRunner, btnRegisterRunner, btnStartRunner, btnStopRunner });
            page.Controls.Add(cardRunner);
        }

        private void BuildSettingsTab(TabPage page)
        {
            int sy = 14;
            Label lblHeader1 = new Label
            {
                Text = "■ 전용 빌드 PC 경로 설정",
                Font = new Font("Malgun Gothic", 11f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(16, sy),
                AutoSize = true
            };
            page.Controls.Add(lblHeader1);
            sy += 34;

            txtUE5Root = AddPathSettingRow(page, "Unreal Engine 설치 경로:", config.UE5Root, ref sy);
            txtWorkspaceRoot = AddPathSettingRow(page, "워크스페이스 상위 폴더:", config.WorkspaceRoot, ref sy);
            txtProjectDir = AddPathSettingRow(page, "연결된 프로젝트 폴더:", config.ProjectDir, ref sy);
            txtSharedAssets = AddPathSettingRow(page, "Git 제외 에셋 원본 폴더:", config.SharedAssetsDir, ref sy);
            txtArchiveRoot = AddPathSettingRow(page, "로그/패키징 아카이브 폴더:", config.ArchiveRoot, ref sy);
            txtRunnerDir = AddPathSettingRow(page, "GitHub Runner 설치 폴더:", config.RunnerDir, ref sy);
            txtGitUrl = AddTextSettingRow(page, "연결된 Git 저장소 URL:", config.GitRemoteUrl, ref sy);
            sy += 8;

            Label lblHeaderGH = new Label
            {
                Text = "■ GitHub API 토큰 & Self-Hosted Runner 설정",
                Font = new Font("Malgun Gothic", 11f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(16, sy),
                AutoSize = true
            };
            page.Controls.Add(lblHeaderGH);
            sy += 34;

            txtGitHubApiToken = AddTextSettingRow(page, "GitHub API 토큰 (ghp_...):", config.GitHubAccessToken, ref sy, true);

            Button btnIssueTokenWeb = CreateFlatButton("→ 1. GitHub 웹에서 API 토큰(ghp_...) 발급 페이지 열기", new Point(210, sy), new Size(360, 31), AccentPurple);
            btnIssueTokenWeb.Click += (s, e) =>
            {
                Process.Start("https://github.com/settings/tokens/new?description=UE_Build_Deploy_Manager&scopes=repo,workflow,read:org");
            };

            Button btnApplyApiToken = CreateFlatButton("✔ 2. 입력한 API 토큰으로 저장소/브랜치 즉시 연동", new Point(578, sy), new Size(320, 31), AccentGreen);
            btnApplyApiToken.Click += async (s, e) =>
            {
                SaveConfigFromUI();
                RefreshConnectedRepoState();
                FetchBranchesViaGitHubApiAsync();
                await ScanAllBranchesForWorkflowAsync(true);
            };
            page.Controls.Add(btnIssueTokenWeb);
            page.Controls.Add(btnApplyApiToken);
            sy += 40;

            txtRunnerToken = AddTextSettingRow(page, "Runner 등록 토큰 (선택):", config.RunnerToken, ref sy);

            Label lblRunnerHint = new Label
            {
                Text = "* [GitHub 로그인 & 저장소 선택]으로 로그인한 경우, 위 토큰을 비워두어도 API로 Runner 등록 토큰을 자동 발급받아 등록합니다!",
                ForeColor = Color.FromArgb(130, 210, 160),
                Font = new Font("Malgun Gothic", 8.8f),
                Location = new Point(210, sy - 6),
                AutoSize = true
            };
            page.Controls.Add(lblRunnerHint);
            sy += 24;

            Button btnOpenRunnerSettings = CreateFlatButton("→ GitHub 웹에서 Runner 토큰 수동 발급 페이지 열기", new Point(210, sy), new Size(340, 33), BgInput);
            btnOpenRunnerSettings.Click += (s, e) =>
            {
                SaveConfigFromUI();
                if (string.IsNullOrWhiteSpace(config.GitHubRepoUrl))
                {
                    MessageBox.Show("먼저 저장소를 연결해 주세요.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Process.Start(config.GitHubRepoUrl + "/settings/actions/runners/new?arch=x64&os=win");
            };

            Button btnCopyWorkflowYml = CreateFlatButton("★ .github/workflows/build.yml 코드 클립보드 복사", new Point(558, sy), new Size(340, 33), AccentPurple);
            btnCopyWorkflowYml.Click += (s, e) =>
            {
                string ymlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "github_workflow_build.yml");
                if (File.Exists(ymlPath))
                {
                    byte[] raw = File.ReadAllBytes(ymlPath);
                    Clipboard.SetText(EncodingHelper.DecodeSmartBytes(raw, raw.Length));
                    MessageBox.Show("github_workflow_build.yml 내용이 클립보드에 복사되었습니다!\n연결된 저장소의 .github/workflows/build.yml 파일로 추가하시면 됩니다.", "복사 완료", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                else
                {
                    MessageBox.Show("github_workflow_build.yml 파일을 찾을 수 없습니다.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            };

            page.Controls.Add(btnOpenRunnerSettings);
            page.Controls.Add(btnCopyWorkflowYml);
            sy += 46;

            Label lblHeader2 = new Label
            {
                Text = "■ Slack 에러 로그 자동 전송 & Tailscale 설정",
                Font = new Font("Malgun Gothic", 11f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(16, sy),
                AutoSize = true
            };
            page.Controls.Add(lblHeader2);
            sy += 34;

            txtSlackToken = AddTextSettingRow(page, "Slack Bot Token (xoxb-...):", config.SlackBotToken, ref sy, true);
            txtSlackChannel = AddTextSettingRow(page, "Slack 채널 ID (예: C01234...):", config.SlackChannelId, ref sy);
            txtTailscaleIP = AddTextSettingRow(page, "전용 PC IP (비워두면 자동감지):", config.TailscaleIP, ref sy);

            Button btnDetectTailscale = CreateFlatButton("이 PC의 IPv4 / Tailscale IP 자동 감지 확인", new Point(210, sy), new Size(310, 34), BgInput);
            btnDetectTailscale.Click += (s, e) => DetectTailscaleIP();

            Button btnTestSlack = CreateFlatButton("Slack 연동 테스트 메시지 보내기", new Point(530, sy), new Size(260, 34), AccentBlue);
            btnTestSlack.Click += async (s, e) => await TestSlackConnectionAsync();

            page.Controls.Add(btnDetectTailscale);
            page.Controls.Add(btnTestSlack);
            sy += 46;

            Button btnSaveCfg = CreateFlatButton("✔ 모든 설정 저장", new Point(210, sy), new Size(240, 40), AccentGreen);
            btnSaveCfg.Font = new Font("Malgun Gothic", 10f, FontStyle.Bold);
            btnSaveCfg.Click += (s, e) =>
            {
                SaveConfigFromUI();
                RefreshConnectedRepoState();
                UpdateCommitBanner();
                CheckAssetLinksSilent();
                UpdateRunnerStatusUI();
                MessageBox.Show("설정이 성공적으로 저장되었습니다.", "저장 완료", MessageBoxButtons.OK, MessageBoxIcon.Information);
            };

            Button btnFactoryReset = CreateFlatButton("[초기화] 배포용 전체 설정 & 데이터 초기화 (Factory Reset)", new Point(460, sy), new Size(350, 40), AccentRed);
            btnFactoryReset.Click += (s, e) => FactoryResetForDistribution();

            page.Controls.Add(btnSaveCfg);
            page.Controls.Add(btnFactoryReset);
        }

        // =====================================================================
        // GitHub Login & Repository Connection Workflow
        // =====================================================================
        private void OpenGitHubConnectDialog()
        {
            using (var dlg = new GitHubConnectDialog(config.GitHubAccessToken, config.GitHubUser))
            {
                if (dlg.ShowDialog(this) == DialogResult.OK && dlg.SelectedRepo != null)
                {
                    var repo = dlg.SelectedRepo;
                    config.GitHubUser = dlg.AuthenticatedUser;
                    config.GitHubAccessToken = dlg.AccessToken;
                    config.ConnectedRepoFullName = repo.FullName;
                    config.GitRemoteUrl = repo.CloneUrl;
                    config.GitHubRepoUrl = repo.HtmlUrl;
                    config.LastBranch = repo.DefaultBranch;
                    config.ProjectDir = Path.Combine(config.WorkspaceRoot, repo.Name);

                    txtProjectDir.Text = config.ProjectDir;
                    txtGitUrl.Text = config.GitRemoteUrl;
                    if (txtGitHubApiToken != null) txtGitHubApiToken.Text = config.GitHubAccessToken;

                    cboBranch.Items.Clear();
                    cboBranch.Items.Add(repo.DefaultBranch);
                    cboBranch.Text = repo.DefaultBranch;

                    SaveConfigFromUI();
                    RefreshConnectedRepoState();
                    UpdateCommitBanner();
                    CheckAssetLinksSilent();

                    AppendConsole(string.Format("✔ [저장소 연결 완료] @{0} 계정의 '{1}' 저장소가 연결되었습니다!", config.GitHubUser, repo.FullName), AccentGreen);
                    AppendConsole("  - 워크스페이스 경로: " + config.ProjectDir, FgSub);

                    // Fetch remote branches via GitHub API immediately even before cloning
                    FetchBranchesViaGitHubApiAsync();
                }
            }
        }

        private void RefreshConnectedRepoState()
        {
            if (!string.IsNullOrWhiteSpace(config.ConnectedRepoFullName))
            {
                lblConnectedRepo.Text = string.Format("● 연결됨: {0} (@{1})", config.ConnectedRepoFullName,
                    string.IsNullOrWhiteSpace(config.GitHubUser) ? "GitHub" : config.GitHubUser);
                lblConnectedRepo.ForeColor = AccentGreen;
                this.Text = string.Format("[{0}] - UE 전용 빌드 & GitHub Actions 매니저", config.ConnectedRepoFullName);
            }
            else if (!string.IsNullOrWhiteSpace(config.GitRemoteUrl))
            {
                lblConnectedRepo.Text = "● 연결됨: " + config.GitRemoteUrl;
                lblConnectedRepo.ForeColor = AccentGreen;
            }
            else
            {
                lblConnectedRepo.Text = "○ 연결된 저장소: 없음 (아래 버튼을 눌러 연결)";
                lblConnectedRepo.ForeColor = Color.FromArgb(255, 205, 86);
                this.Text = "Unreal Engine 전용 빌드 & GitHub Actions 자동 배포 매니저";
                if (lblWorkflowStatus != null)
                {
                    lblWorkflowStatus.Text = "○ 브랜치 워크플로우(build.yml): 저장소 연결 후 자동 확인";
                    lblWorkflowStatus.ForeColor = FgSub;
                }
                if (lblLeftWfBadge != null)
                {
                    lblLeftWfBadge.Text = "○ 워크플로우: 저장소 연결 필요 ([3] 탭)";
                    lblLeftWfBadge.ForeColor = FgSub;
                }
            }
        }

        private async void FetchBranchesViaGitHubApiAsync()
        {
            if (string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) || string.IsNullOrWhiteSpace(config.GitHubAccessToken))
                return;

            await Task.Run(() =>
            {
                try
                {
                    string url = string.Format("https://api.github.com/repos/{0}/branches?per_page=100", config.ConnectedRepoFullName);
                    string json = GitHubApiGet(url, config.GitHubAccessToken);
                    var serializer = new JavaScriptSerializer();
                    var list = serializer.Deserialize<List<Dictionary<string, object>>>(json);
                    if (list != null && list.Count > 0)
                    {
                        var names = list.Where(b => b.ContainsKey("name") && b["name"] != null)
                                        .Select(b => b["name"].ToString())
                                        .ToArray();
                        this.BeginInvoke(new Action(async () =>
                        {
                            string cur = cboBranch.Text;
                            cboBranch.Items.Clear();
                            cboBranch.Items.AddRange(names);
                            cboBranch.Text = (!string.IsNullOrEmpty(cur) && names.Contains(cur)) ? cur : names[0];
                            AppendConsole("[GitHub API] 원격 브랜치 목록 자동 로드 완료: " + string.Join(", ", names), Color.Cyan);
                            await ScanAllBranchesForWorkflowAsync(false);
                        }));
                    }
                }
                catch { }
            });
        }

        private async void CheckSelectedBranchWorkflowAsync(string branch)
        {
            if (lblWorkflowStatus == null) return;
            if (string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) || string.IsNullOrWhiteSpace(config.GitHubAccessToken) || string.IsNullOrWhiteSpace(branch))
            {
                lblWorkflowStatus.Text = "○ 브랜치 워크플로우(build.yml): 저장소/브랜치 선택 필요";
                lblWorkflowStatus.ForeColor = FgSub;
                if (lblLeftWfBadge != null)
                {
                    lblLeftWfBadge.Text = "○ 워크플로우: 저장소/브랜치 선택 필요";
                    lblLeftWfBadge.ForeColor = FgSub;
                }
                return;
            }

            lblWorkflowStatus.Text = string.Format("● '{0}' 브랜치의 build.yml 확인 중...", branch);
            lblWorkflowStatus.ForeColor = Color.FromArgb(255, 205, 86);
            if (lblLeftWfBadge != null)
            {
                lblLeftWfBadge.Text = string.Format("● [{0}] build.yml 확인 중...", branch);
                lblLeftWfBadge.ForeColor = Color.FromArgb(255, 205, 86);
            }

            await Task.Run(() =>
            {
                var serializer = new JavaScriptSerializer();
                List<string> foundYmls = new List<string>();
                try
                {
                    string wfUrl = string.Format("https://api.github.com/repos/{0}/contents/.github/workflows?ref={1}",
                        config.ConnectedRepoFullName, Uri.EscapeDataString(branch));
                    string wfJson = GitHubApiGet(wfUrl, config.GitHubAccessToken);
                    var items = serializer.Deserialize<List<Dictionary<string, object>>>(wfJson);
                    if (items != null)
                    {
                        foreach (var item in items)
                        {
                            if (item.ContainsKey("name") && item["name"] != null)
                            {
                                string fn = item["name"].ToString();
                                if (fn.EndsWith(".yml", StringComparison.OrdinalIgnoreCase) || fn.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase))
                                    foundYmls.Add(fn);
                            }
                        }
                    }
                }
                catch { }

                string runInfo = "";
                if (foundYmls.Count > 0)
                {
                    try
                    {
                        string runUrl = string.Format("https://api.github.com/repos/{0}/actions/runs?branch={1}&per_page=1",
                            config.ConnectedRepoFullName, Uri.EscapeDataString(branch));
                        string runJson = GitHubApiGet(runUrl, config.GitHubAccessToken);
                        var runDict = serializer.Deserialize<Dictionary<string, object>>(runJson);
                        if (runDict != null && runDict.ContainsKey("workflow_runs"))
                        {
                            var runs = runDict["workflow_runs"] as System.Collections.ArrayList;
                            if (runs != null && runs.Count > 0)
                            {
                                var r0 = runs[0] as Dictionary<string, object>;
                                if (r0 != null)
                                {
                                    string st = r0.ContainsKey("status") && r0["status"] != null ? r0["status"].ToString() : "";
                                    string conc = r0.ContainsKey("conclusion") && r0["conclusion"] != null ? r0["conclusion"].ToString() : "";
                                    if (st == "queued") runInfo = " | 최근 Actions: 대기 중(Runner 가동 필요)";
                                    else if (st == "in_progress") runInfo = " | 최근 Actions: 빌드 실행 중";
                                    else if (st == "completed") runInfo = " | 최근 Actions: " + (conc == "success" ? "성공" : conc);
                                }
                            }
                        }
                    }
                    catch { }
                }

                this.BeginInvoke(new Action(() =>
                {
                    if (foundYmls.Count > 0)
                    {
                        lblWorkflowStatus.Text = string.Format("● [{0}] 워크플로우 감지됨: {1}{2}", branch, string.Join(", ", foundYmls), runInfo);
                        lblWorkflowStatus.ForeColor = AccentGreen;
                        if (lblLeftWfBadge != null)
                        {
                            lblLeftWfBadge.Text = string.Format("● [{0}] {1} 감지됨", branch, string.Join(", ", foundYmls));
                            lblLeftWfBadge.ForeColor = AccentGreen;
                        }
                    }
                    else
                    {
                        lblWorkflowStatus.Text = string.Format("✖ [{0}] 브랜치에 build.yml 없음 (아래 버튼으로 스캔/등록)", branch);
                        lblWorkflowStatus.ForeColor = AccentOrange;
                        if (lblLeftWfBadge != null)
                        {
                            lblLeftWfBadge.Text = string.Format("✖ [{0}] build.yml 없음 (클릭해 [3]탭 등록)", branch);
                            lblLeftWfBadge.ForeColor = AccentOrange;
                        }
                    }
                }));
            });
        }

        private async Task ScanAllBranchesForWorkflowAsync(bool showPopup)
        {
            if (string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) || string.IsNullOrWhiteSpace(config.GitHubAccessToken))
            {
                if (showPopup)
                    MessageBox.Show("먼저 좌측 상단 [GitHub 로그인 & 사용할 저장소 선택하기]로 저장소를 연결해 주세요.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            AppendConsole("\n=== [GitHub API] 모든 원격 브랜치의 .github/workflows/build.yml 및 Actions 상태 스캔 중... ===", Color.Cyan);
            var serializer = new JavaScriptSerializer();
            List<string> branchesWithWf = new List<string>();
            List<string> branchesWithoutWf = new List<string>();
            StringBuilder report = new StringBuilder();

            await Task.Run(() =>
            {
                try
                {
                    string brUrl = string.Format("https://api.github.com/repos/{0}/branches?per_page=100", config.ConnectedRepoFullName);
                    string brJson = GitHubApiGet(brUrl, config.GitHubAccessToken);
                    var brList = serializer.Deserialize<List<Dictionary<string, object>>>(brJson);
                    if (brList != null)
                    {
                        foreach (var b in brList)
                        {
                            if (!b.ContainsKey("name") || b["name"] == null) continue;
                            string bName = b["name"].ToString();
                            List<string> ymls = new List<string>();
                            try
                            {
                                string wfUrl = string.Format("https://api.github.com/repos/{0}/contents/.github/workflows?ref={1}",
                                    config.ConnectedRepoFullName, Uri.EscapeDataString(bName));
                                string wfJson = GitHubApiGet(wfUrl, config.GitHubAccessToken);
                                var items = serializer.Deserialize<List<Dictionary<string, object>>>(wfJson);
                                if (items != null)
                                {
                                    foreach (var item in items)
                                    {
                                        if (item.ContainsKey("name") && item["name"] != null)
                                        {
                                            string fn = item["name"].ToString();
                                            if (fn.EndsWith(".yml", StringComparison.OrdinalIgnoreCase) || fn.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase))
                                                ymls.Add(fn);
                                        }
                                    }
                                }
                            }
                            catch { }

                            if (ymls.Count > 0)
                            {
                                branchesWithWf.Add(bName);
                                string line = string.Format("  ✔ [감지됨] '{0}' 브랜치 -> .github/workflows/{1}", bName, string.Join(", ", ymls));
                                AppendConsole(line, AccentGreen);
                                report.AppendLine(line);
                            }
                            else
                            {
                                branchesWithoutWf.Add(bName);
                                string line = string.Format("  - [없음] '{0}' 브랜치 -> .github/workflows 폴더 없음", bName);
                                AppendConsole(line, FgSub);
                                report.AppendLine(line);
                            }
                        }
                    }

                    // Also check recent GitHub Actions workflow runs
                    string runsUrl = string.Format("https://api.github.com/repos/{0}/actions/runs?per_page=5", config.ConnectedRepoFullName);
                    string runsJson = GitHubApiGet(runsUrl, config.GitHubAccessToken);
                    var runsDict = serializer.Deserialize<Dictionary<string, object>>(runsJson);
                    if (runsDict != null && runsDict.ContainsKey("workflow_runs"))
                    {
                        var runs = runsDict["workflow_runs"] as System.Collections.ArrayList;
                        if (runs != null && runs.Count > 0)
                        {
                            report.AppendLine("\n[최근 GitHub Actions 워크플로우 실행 기록]");
                            AppendConsole("--- 최근 GitHub Actions 워크플로우 실행 감지 내역 ---", Color.Cyan);
                            foreach (var rObj in runs)
                            {
                                var r = rObj as Dictionary<string, object>;
                                if (r == null) continue;
                                string hBranch = r.ContainsKey("head_branch") && r["head_branch"] != null ? r["head_branch"].ToString() : "";
                                string status = r.ContainsKey("status") && r["status"] != null ? r["status"].ToString() : "";
                                string conclusion = r.ContainsKey("conclusion") && r["conclusion"] != null ? r["conclusion"].ToString() : "진행/대기중";
                                string title = r.ContainsKey("display_title") && r["display_title"] != null ? r["display_title"].ToString() : "";
                                string rLine = string.Format("  • 브랜치 [{0}] | 상태: {1} ({2}) | 커밋: {3}", hBranch, status, conclusion, title);
                                AppendConsole(rLine, status == "queued" ? Color.Yellow : FgText);
                                report.AppendLine(rLine);
                            }
                        }
                        else
                        {
                            report.AppendLine("\n[최근 GitHub Actions 실행 기록]: 아직 실행된 워크플로우 기록이 없습니다.");
                        }
                    }
                }
                catch (Exception ex)
                {
                    AppendConsole("[스캔 오류] " + ex.Message, AccentRed);
                }
            });

            if (branchesWithWf.Count > 0 && !branchesWithWf.Contains(cboBranch.Text.Trim()))
            {
                string targetBr = branchesWithWf[0];
                cboBranch.Text = targetBr;
                AppendConsole(string.Format("▶ build.yml이 존재하는 '{0}' 브랜치로 대상 브랜치를 자동 전환했습니다!", targetBr), AccentGreen);
            }

            CheckSelectedBranchWorkflowAsync(cboBranch.Text.Trim());

            if (showPopup)
            {
                string summaryHeader = branchesWithWf.Count > 0
                    ? string.Format("✔ 총 {0}개 브랜치에서 build.yml 워크플로우가 확인되었습니다: [{1}]\n\n", branchesWithWf.Count, string.Join(", ", branchesWithWf))
                    : "✖ 아직 어떤 브랜치에서도 .github/workflows/build.yml 파일이 감지되지 않았습니다.\n([★ 선택한 브랜치에 build.yml 원클릭 자동 커밋] 버튼으로 즉시 추가할 수 있습니다.)\n\n";

                MessageBox.Show(summaryHeader + report.ToString() +
                    "\n[참고] 특정 브랜치에 커밋/Push했을 때 이 PC에서 자동으로 빌드가 돌게 하려면 좌측 [3. 무인 자동 감지 빌더]에서 [★ API 자동 감지 빌더 가동]을 켜두세요!",
                    "브랜치별 build.yml 및 GitHub Actions 감지 결과", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        private async Task PushWorkflowToSelectedBranchAsync()
        {
            SaveConfigFromUI();
            string branch = cboBranch.Text.Trim();
            if (string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) || string.IsNullOrWhiteSpace(config.GitHubAccessToken))
            {
                MessageBox.Show("먼저 좌측 상단 [GitHub 로그인 & 사용할 저장소 선택하기]로 저장소를 연결해 주세요.", "저장소 연결 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.IsNullOrWhiteSpace(branch))
            {
                MessageBox.Show("대상 브랜치를 먼저 선택해 주세요.", "브랜치 선택 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string ymlPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "github_workflow_build.yml");
            if (!File.Exists(ymlPath))
            {
                MessageBox.Show("실행 폴더에서 github_workflow_build.yml 템플릿 파일을 찾을 수 없습니다.", "파일 없음", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            var confirm = MessageBox.Show(
                string.Format("선택한 '{0}' 브랜치에 '.github/workflows/build.yml' 파일을 자동으로 커밋(Push)하시겠습니까?\n\n" +
                              "- 대상 저장소: {1}\n" +
                              "- 대상 브랜치: {0}\n" +
                              "- 생성 경로: .github/workflows/build.yml\n\n" +
                              "(Push 즉시 GitHub Actions 워크플로우가 등록되며, Runner가 가동 중이면 자동 빌드가 시작됩니다.)",
                              branch, config.ConnectedRepoFullName),
                "선택 브랜치에 build.yml 원클릭 자동 등록",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question);

            if (confirm != DialogResult.Yes) return;

            byte[] rawYml = File.ReadAllBytes(ymlPath);
            string cleanYml = EncodingHelper.DecodeSmartBytes(rawYml, rawYml.Length);
            string base64Content = Convert.ToBase64String(Encoding.UTF8.GetBytes(cleanYml));

            AppendConsole(string.Format("\n=== [GitHub API] '{0}' 브랜치에 .github/workflows/build.yml 자동 커밋(Push) 진행 중... ===", branch), Color.Cyan);

            await Task.Run(() =>
            {
                try
                {
                    var serializer = new JavaScriptSerializer();
                    string apiUrl = string.Format("https://api.github.com/repos/{0}/contents/.github/workflows/build.yml", config.ConnectedRepoFullName);

                    // Check if file already exists on that branch to get its blob SHA
                    string existingSha = null;
                    try
                    {
                        string getJson = GitHubApiGet(apiUrl + "?ref=" + Uri.EscapeDataString(branch), config.GitHubAccessToken);
                        var existingDict = serializer.Deserialize<Dictionary<string, object>>(getJson);
                        if (existingDict != null && existingDict.ContainsKey("sha") && existingDict["sha"] != null)
                            existingSha = existingDict["sha"].ToString();
                    }
                    catch { }

                    var bodyObj = new Dictionary<string, object>
                    {
                        { "message", "ci: add Unreal Engine GitHub Actions build workflow (build.yml)" },
                        { "content", base64Content },
                        { "branch", branch }
                    };
                    if (!string.IsNullOrEmpty(existingSha))
                        bodyObj["sha"] = existingSha;

                    string putPayload = serializer.Serialize(bodyObj);
                    GitHubApiPut(apiUrl, config.GitHubAccessToken, putPayload);

                    this.BeginInvoke(new Action(() =>
                    {
                        AppendConsole(string.Format("✔ ['{0}' 브랜치] .github/workflows/build.yml 자동 커밋 및 Push가 완료되었습니다!", branch), AccentGreen);
                        CheckSelectedBranchWorkflowAsync(branch);
                        MessageBox.Show(
                            string.Format("'{0}' 브랜치에 .github/workflows/build.yml 등록이 완료되었습니다!\n\n" +
                                          "이제 좌측 [★ API 자동 감지 빌더 가동]이 켜져 있으면 해당 브랜치의 빌드가 이 PC에서 자동으로 시작됩니다.", branch),
                            "build.yml 원클릭 등록 완료", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }));
                }
                catch (Exception ex)
                {
                    this.BeginInvoke(new Action(() =>
                    {
                        AppendConsole("[build.yml 자동 등록 실패] " + ex.Message, AccentRed);
                        MessageBox.Show("GitHub API로 build.yml 커밋 중 오류가 발생했습니다:\n" + ex.Message +
                            "\n\n(토큰에 'workflow' 및 'repo' 권한이 포함되어 있는지 확인해 주세요.)", "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }));
                }
            });
        }

        private string GetAuthenticatedCloneUrl()
        {
            if (!string.IsNullOrWhiteSpace(config.GitHubAccessToken) &&
                config.GitRemoteUrl.StartsWith("https://github.com/", StringComparison.OrdinalIgnoreCase))
            {
                return config.GitRemoteUrl.Replace("https://github.com/", "https://x-access-token:" + config.GitHubAccessToken + "@github.com/");
            }
            return config.GitRemoteUrl;
        }

        private TextBox AddPathSettingRow(TabPage page, string label, string val, ref int y)
        {
            Label lbl = new Label { Text = label, Location = new Point(16, y + 5), Width = 190, ForeColor = FgSub };
            TextBox txt = new TextBox
            {
                Text = val,
                Location = new Point(210, y),
                Width = 490,
                BackColor = BgInput,
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle
            };
            Button btnBrowse = CreateFlatButton("찾아보기...", new Point(708, y - 1), new Size(84, 27), BgInput);
            btnBrowse.Click += (s, e) =>
            {
                using (var fbd = new FolderBrowserDialog { SelectedPath = txt.Text })
                {
                    if (fbd.ShowDialog() == DialogResult.OK)
                        txt.Text = fbd.SelectedPath;
                }
            };
            page.Controls.AddRange(new Control[] { lbl, txt, btnBrowse });
            y += 35;
            return txt;
        }

        private TextBox AddTextSettingRow(TabPage page, string label, string val, ref int y, bool isPassword = false)
        {
            Label lbl = new Label { Text = label, Location = new Point(16, y + 5), Width = 190, ForeColor = FgSub };
            TextBox txt = new TextBox
            {
                Text = val,
                Location = new Point(210, y),
                Width = 580,
                BackColor = BgInput,
                ForeColor = Color.White,
                BorderStyle = BorderStyle.FixedSingle,
                UseSystemPasswordChar = isPassword
            };
            page.Controls.AddRange(new Control[] { lbl, txt });
            y += 35;
            return txt;
        }

        private Label CreateSectionHeader(string title, ref int y)
        {
            Label lbl = new Label
            {
                Text = title,
                Location = new Point(10, y),
                Size = new Size(350, 22),
                ForeColor = Color.FromArgb(130, 190, 255),
                Font = new Font("Malgun Gothic", 9.5f, FontStyle.Bold)
            };
            y += 24;
            return lbl;
        }

        private Button CreateFlatButton(string text, Point loc, Size size, Color bg)
        {
            Button btn = new Button
            {
                Text = text,
                Location = loc,
                Size = size,
                BackColor = bg,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = Color.FromArgb(70, 78, 92);
            btn.FlatAppearance.BorderSize = 1;
            return btn;
        }

        private void AppendConsole(string line, Color? color = null)
        {
            if (this.InvokeRequired)
            {
                this.BeginInvoke(new Action(() => AppendConsole(line, color)));
                return;
            }
            if (line == null) return;

            fullConsoleBuffer.AppendLine(line);

            Color c = color ?? FgText;
            bool isError = Regex.IsMatch(line, @"error C\d+:|\bfatal error\b|Error:|Ensure condition failed|Unable to find plugin|Result: Failed|UnrealBuildTool failed|AutomationTool exiting with ExitCode=[1-9]", RegexOptions.IgnoreCase);
            bool isWarn = !isError && Regex.IsMatch(line, @"warning C\d+:|\bWarning:", RegexOptions.IgnoreCase);

            if (isError) c = Color.FromArgb(255, 95, 95);
            else if (isWarn) c = Color.FromArgb(255, 210, 90);

            rtbConsole.SelectionStart = rtbConsole.TextLength;
            rtbConsole.SelectionLength = 0;
            rtbConsole.SelectionColor = c;
            rtbConsole.AppendText(line + Environment.NewLine);
            rtbConsole.ScrollToCaret();

            if (isError)
            {
                rtbErrorsOnly.SelectionStart = rtbErrorsOnly.TextLength;
                rtbErrorsOnly.SelectionColor = Color.FromArgb(255, 110, 110);
                rtbErrorsOnly.AppendText(line + Environment.NewLine);
                rtbErrorsOnly.ScrollToCaret();
            }
        }

        private void SetStatus(string text, Color bg)
        {
            if (this.InvokeRequired)
            {
                this.BeginInvoke(new Action(() => SetStatus(text, bg)));
                return;
            }
            lblStatusBadge.Text = " " + text + " ";
            lblStatusBadge.BackColor = bg;
        }

        private void UpdateCommitBanner()
        {
            string uiBranch = (cboBranch != null && !string.IsNullOrWhiteSpace(cboBranch.Text)) ? cboBranch.Text.Trim() : config.LastBranch;
            Task.Run(() =>
            {
                try
                {
                    bool hasLocalGit = !string.IsNullOrWhiteSpace(config.ProjectDir) && Directory.Exists(Path.Combine(config.ProjectDir, ".git"));
                    if (!hasLocalGit && string.IsNullOrWhiteSpace(config.ConnectedRepoFullName))
                    {
                        this.BeginInvoke(new Action(() =>
                        {
                            lblCommitInfo.Text = "연결된 저장소 없음 — 좌측 [▶ GitHub 저장소 연결 / 변경]을 눌러 시작하세요.";
                        }));
                        return;
                    }

                    string branch, hash, author, msg;
                    ResolveCommitMetadata(uiBranch, out branch, out hash, out author, out msg);

                    this.BeginInvoke(new Action(() =>
                    {
                        lblCommitInfo.Text = string.Format("워크스페이스: [{0}] {1} ({2}) - {3}", branch, hash, author, msg);
                    }));
                }
                catch
                {
                    this.BeginInvoke(new Action(() =>
                    {
                        lblCommitInfo.Text = "Git 커밋 정보를 읽을 수 없습니다.";
                    }));
                }
            });
        }

        private void ResolveCommitMetadata(string requestedBranch, out string resolvedBranch, out string hash, out string author, out string msg)
        {
            resolvedBranch = !string.IsNullOrWhiteSpace(requestedBranch) ? requestedBranch.Trim() : "";
            hash = "";
            author = "";
            msg = "";

            if (!string.IsNullOrWhiteSpace(config.ProjectDir) && Directory.Exists(Path.Combine(config.ProjectDir, ".git")))
            {
                string localBranch = RunGitQuick("rev-parse --abbrev-ref HEAD");
                if (string.IsNullOrWhiteSpace(resolvedBranch) && !string.IsNullOrWhiteSpace(localBranch) && localBranch != "HEAD")
                {
                    resolvedBranch = localBranch;
                }
                hash = RunGitQuick("rev-parse --short HEAD");
                author = RunGitQuick("log -1 --pretty=format:%an");
                msg = RunGitQuick("log -1 --pretty=format:%s");
            }

            if (string.IsNullOrWhiteSpace(resolvedBranch))
            {
                resolvedBranch = !string.IsNullOrWhiteSpace(config.LastBranch) ? config.LastBranch : "main";
            }

            // 로컬 Git에서 소유권(safe.directory) 문제나 미동기화로 커밋 정보를 가져오지 못한 경우 GitHub Commits API로 즉시 보완
            if ((string.IsNullOrWhiteSpace(hash) || string.IsNullOrWhiteSpace(author) || string.IsNullOrWhiteSpace(msg)) &&
                !string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) &&
                !string.IsNullOrWhiteSpace(config.GitHubAccessToken))
            {
                try
                {
                    string apiUrl = string.Format("https://api.github.com/repos/{0}/commits/{1}",
                        config.ConnectedRepoFullName, Uri.EscapeDataString(resolvedBranch));
                    string json = GitHubApiGet(apiUrl, config.GitHubAccessToken);
                    var serializer = new JavaScriptSerializer();
                    var dict = serializer.Deserialize<Dictionary<string, object>>(json);
                    if (dict != null)
                    {
                        if (string.IsNullOrWhiteSpace(hash) && dict.ContainsKey("sha") && dict["sha"] != null)
                        {
                            string fullSha = dict["sha"].ToString();
                            hash = fullSha.Length > 7 ? fullSha.Substring(0, 7) : fullSha;
                        }

                        string apiAuthorName = "";
                        string apiAuthorLogin = "";
                        if (dict.ContainsKey("commit") && dict["commit"] is Dictionary<string, object>)
                        {
                            var commitObj = (Dictionary<string, object>)dict["commit"];
                            if (string.IsNullOrWhiteSpace(msg) && commitObj.ContainsKey("message") && commitObj["message"] != null)
                            {
                                string rawMsg = commitObj["message"].ToString();
                                msg = rawMsg.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
                            }
                            if (commitObj.ContainsKey("author") && commitObj["author"] is Dictionary<string, object>)
                            {
                                var commitAuthorObj = (Dictionary<string, object>)commitObj["author"];
                                if (commitAuthorObj.ContainsKey("name") && commitAuthorObj["name"] != null)
                                    apiAuthorName = commitAuthorObj["name"].ToString();
                            }
                        }
                        if (dict.ContainsKey("author") && dict["author"] is Dictionary<string, object>)
                        {
                            var ghAuthorObj = (Dictionary<string, object>)dict["author"];
                            if (ghAuthorObj.ContainsKey("login") && ghAuthorObj["login"] != null)
                                apiAuthorLogin = ghAuthorObj["login"].ToString();
                        }

                        if (string.IsNullOrWhiteSpace(author))
                        {
                            if (!string.IsNullOrWhiteSpace(apiAuthorName) && !string.IsNullOrWhiteSpace(apiAuthorLogin) &&
                                !apiAuthorName.Equals(apiAuthorLogin, StringComparison.OrdinalIgnoreCase))
                            {
                                author = string.Format("{0} (@{1})", apiAuthorName, apiAuthorLogin);
                            }
                            else if (!string.IsNullOrWhiteSpace(apiAuthorLogin))
                            {
                                author = apiAuthorLogin;
                            }
                            else if (!string.IsNullOrWhiteSpace(apiAuthorName))
                            {
                                author = apiAuthorName;
                            }
                        }
                    }
                }
                catch { }
            }

            if (string.IsNullOrWhiteSpace(hash)) hash = "latest";
            if (string.IsNullOrWhiteSpace(author)) author = !string.IsNullOrWhiteSpace(config.GitHubUser) ? config.GitHubUser : Environment.UserName;
            if (string.IsNullOrWhiteSpace(msg)) msg = "(커밋 메시지 없음)";
        }

        private string RunGitQuick(string args)
        {
            if (string.IsNullOrWhiteSpace(config.ProjectDir) || !Directory.Exists(config.ProjectDir))
                return "";

            try
            {
                string fullArgs = "-c safe.directory=* -c core.quotepath=false -c i18n.logOutputEncoding=utf-8 " + args;
                var psi = new ProcessStartInfo("git", fullArgs)
                {
                    WorkingDirectory = config.ProjectDir,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                using (var ms = new MemoryStream())
                {
                    p.StandardOutput.BaseStream.CopyTo(ms);
                    p.WaitForExit(4000);
                    byte[] raw = ms.ToArray();
                    return EncodingHelper.DecodeSmartBytes(raw, raw.Length).Trim();
                }
            }
            catch
            {
                return "";
            }
        }

        // =====================================================================
        // Feature: GitHub Actions Self-Hosted Runner Management
        // =====================================================================
        private void UpdateRunnerStatusUI()
        {
            if (lblRunnerStatus == null) return;
            string configCmd = Path.Combine(config.RunnerDir, "config.cmd");
            string runnerCfg = Path.Combine(config.RunnerDir, ".runner");
            bool isRunning = (runnerProcess != null && !runnerProcess.HasExited) ||
                             Process.GetProcessesByName("Runner.Listener").Length > 0;

            if (isApiPolling)
            {
                lblRunnerStatus.Text = "● 상태: API 자동 감지 빌더 작동 중 (15초 주기 감시)";
                lblRunnerStatus.ForeColor = AccentGreen;
            }
            else if (isRunning)
            {
                lblRunnerStatus.Text = "● Runner 상태: 작동 중 (GitHub 커밋 대기/수신 중)";
                lblRunnerStatus.ForeColor = AccentGreen;
                btnStartRunner.Enabled = false;
                btnStopRunner.Enabled = true;
            }
            else if (File.Exists(runnerCfg))
            {
                lblRunnerStatus.Text = "● Runner 상태: 등록 완료 (대기/중지 상태)";
                lblRunnerStatus.ForeColor = Color.FromArgb(255, 205, 86);
                btnStartRunner.Enabled = true;
                btnStopRunner.Enabled = false;
            }
            else if (File.Exists(configCmd))
            {
                lblRunnerStatus.Text = "● 상태: API 자동 빌더 대기 중 (또는 Runner 등록 가능)";
                lblRunnerStatus.ForeColor = AccentOrange;
                btnStartRunner.Enabled = false;
                btnStopRunner.Enabled = false;
            }
            else
            {
                lblRunnerStatus.Text = "○ 상태: 아래 [★ API 자동 감지 빌더 가동]을 눌러 시작";
                lblRunnerStatus.ForeColor = FgSub;
                btnStartRunner.Enabled = false;
                btnStopRunner.Enabled = false;
            }
        }

        private void ToggleApiAutoPoller()
        {
            SaveConfigFromUI();
            if (isApiPolling)
            {
                isApiPolling = false;
                if (apiPollTimer != null) apiPollTimer.Stop();
                btnToggleApiPoller.Text = "★ API 자동 감지 빌더 가동 (방장권한 불필요)";
                btnToggleApiPoller.BackColor = AccentGreen;
                AppendConsole("■ [API 자동 감지 빌더] 감시가 중지되었습니다.", AccentOrange);
                UpdateRunnerStatusUI();
                return;
            }

            if (string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) || string.IsNullOrWhiteSpace(config.GitHubAccessToken))
            {
                MessageBox.Show(
                    "API 자동 감지 빌더를 가동하려면 먼저 GitHub API 토큰(ghp_...)과 저장소가 연결되어 있어야 합니다!\n\n" +
                    "• 방법 1: 좌측 상단 [▶ GitHub 저장소 연결 / 변경]에서 토큰 입력 후 저장소 선택\n" +
                    "• 방법 2: 상단 [[5] 경로 & 토큰 설정] 탭에서 'GitHub API 토큰 (ghp_...)' 입력 후 [✔ 2. 입력한 API 토큰으로 저장소/브랜치 즉시 연동] 클릭",
                    "GitHub API 토큰 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                if (tabSettingsPage != null) tabMain.SelectedTab = tabSettingsPage;
                return;
            }

            isApiPolling = true;
            btnToggleApiPoller.Text = "■ API 자동 감지 빌더 중지 (15초 감시 중)";
            btnToggleApiPoller.BackColor = AccentRed;
            UpdateRunnerStatusUI();

            AppendConsole(string.Format("\n▶ [API 자동 감지 빌더 가동] '{0}' 저장소의 모든 브랜치 커밋 및 대기 중(Queued)인 Actions를 15초 주기로 자동 감시합니다!", config.ConnectedRepoFullName), AccentGreen);
            AppendConsole("  (저장소 방장 권한이나 별도 Runner 등록 토큰 없이도 내 API 토큰만으로 자동 빌드가 즉시 실행됩니다.)", FgSub);

            if (apiPollTimer == null)
            {
                apiPollTimer = new Timer { Interval = 15000 };
                apiPollTimer.Tick += async (s, e) => await PollGitHubActionsAndBuildAsync();
            }
            apiPollTimer.Start();

            var _ = PollGitHubActionsAndBuildAsync();
        }

        private async Task PollGitHubActionsAndBuildAsync()
        {
            if (!isApiPolling || isBuilding || isPollChecking) return;
            if (string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) || string.IsNullOrWhiteSpace(config.GitHubAccessToken)) return;

            isPollChecking = true;
            try
            {
                string triggerBranch = null;
                string triggerSha = null;
                string triggerRunId = null;
                string triggerTitle = null;

                await Task.Run(() =>
                {
                    try
                    {
                        var serializer = new JavaScriptSerializer();
                        string runsUrl = string.Format("https://api.github.com/repos/{0}/actions/runs?per_page=10", config.ConnectedRepoFullName);
                        string runsJson = GitHubApiGet(runsUrl, config.GitHubAccessToken);
                        var runsDict = serializer.Deserialize<Dictionary<string, object>>(runsJson);
                        if (runsDict != null && runsDict.ContainsKey("workflow_runs"))
                        {
                            var runs = runsDict["workflow_runs"] as System.Collections.ArrayList;
                            if (runs != null)
                            {
                                foreach (var rObj in runs)
                                {
                                    var r = rObj as Dictionary<string, object>;
                                    if (r == null) continue;
                                    string status = r.ContainsKey("status") && r["status"] != null ? r["status"].ToString() : "";
                                    string runId = r.ContainsKey("id") && r["id"] != null ? r["id"].ToString() : "";
                                    string branch = r.ContainsKey("head_branch") && r["head_branch"] != null ? r["head_branch"].ToString() : "";
                                    string sha = r.ContainsKey("head_sha") && r["head_sha"] != null ? r["head_sha"].ToString() : "";
                                    string title = r.ContainsKey("display_title") && r["display_title"] != null ? r["display_title"].ToString() : "";

                                    if (status == "queued" && !string.IsNullOrEmpty(runId) && !processedRunOrCommitIds.Contains("run:" + runId))
                                    {
                                        triggerRunId = runId;
                                        triggerBranch = branch;
                                        triggerSha = sha;
                                        triggerTitle = title;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    catch { }
                });

                if (!string.IsNullOrEmpty(triggerRunId) && !string.IsNullOrEmpty(triggerBranch))
                {
                    processedRunOrCommitIds.Add("run:" + triggerRunId);
                    AppendConsole(string.Format("\n★ [API 자동 감지] '{0}' 브랜치에서 대기 중(Queued)인 워크플로우(#{1}: {2})를 감지했습니다!", triggerBranch, triggerRunId, triggerTitle), AccentGreen);

                    // GitHub 웹에서 무한 Queued 상태로 남지 않도록 취소 요청 시도
                    await Task.Run(() =>
                    {
                        try
                        {
                            string cancelUrl = string.Format("https://api.github.com/repos/{0}/actions/runs/{1}/cancel", config.ConnectedRepoFullName, triggerRunId);
                            GitHubApiPost(cancelUrl, config.GitHubAccessToken);
                            AppendConsole("[GitHub API] 웹상의 무한 Queued 대기 표시를 해제하고 이 전용 PC에서 직접 빌드를 인계받습니다.", Color.Cyan);
                        }
                        catch { }
                    });

                    cboBranch.Text = triggerBranch;

                    // 워크스페이스에 아직 클론되지 않았다면 자동 클론
                    if (string.IsNullOrWhiteSpace(config.ProjectDir) || !Directory.Exists(Path.Combine(config.ProjectDir, ".git")))
                    {
                        await CloneRepositoryAsync();
                    }

                    await RunGitSyncAsync(triggerBranch);

                    string buildMode = (triggerBranch.Equals("main", StringComparison.OrdinalIgnoreCase) ||
                                        triggerBranch.Equals("master", StringComparison.OrdinalIgnoreCase))
                        ? "FullPackage" : "QuickVerify";

                    await StartUEBuildAsync(buildMode, triggerBranch);
                }
            }
            finally
            {
                isPollChecking = false;
            }
        }

        private async Task DownloadAndExtractRunnerAsync()
        {
            SaveConfigFromUI();
            if (!Directory.Exists(config.RunnerDir))
                Directory.CreateDirectory(config.RunnerDir);

            if (File.Exists(Path.Combine(config.RunnerDir, "config.cmd")))
            {
                MessageBox.Show("이미 해당 폴더에 GitHub Actions Runner가 설치되어 있습니다:\n" + config.RunnerDir, "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                UpdateRunnerStatusUI();
                return;
            }

            SetStatus("▼ GitHub Runner 다운로드 중...", AccentBlue);
            AppendConsole("=== GitHub Actions Runner (Windows x64) 최신 릴리스 다운로드 시작 ===", Color.Cyan);

            await Task.Run(() =>
            {
                string psCmd = string.Format(
                    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
                    "$ProgressPreference = 'SilentlyContinue'; " +
                    "$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{{ 'User-Agent'='UE-BuildManager' }}; " +
                    "$asset = $rel.assets | Where-Object {{ $_.name -like 'actions-runner-win-x64-*.zip' }} | Select-Object -First 1; " +
                    "$zipPath = Join-Path '{0}' $asset.name; " +
                    "Write-Output ('다운로드 URL: ' + $asset.browser_download_url); " +
                    "Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath; " +
                    "Write-Output '압축 해제 중...'; " +
                    "Expand-Archive -Path $zipPath -DestinationPath '{0}' -Force; " +
                    "Remove-Item $zipPath -Force; " +
                    "Write-Output 'GitHub Actions Runner 설치가 완료되었습니다!'",
                    config.RunnerDir);

                RunProcessStream("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -Command \"" + psCmd + "\"", config.RunnerDir);
            });

            SetStatus("● 대기 중 (IDLE)", Color.FromArgb(52, 58, 64));
            UpdateRunnerStatusUI();
        }

        private async Task RegisterGitHubRunnerAsync()
        {
            SaveConfigFromUI();
            string configCmd = Path.Combine(config.RunnerDir, "config.cmd");
            if (!File.Exists(configCmd))
            {
                MessageBox.Show("먼저 [[1] GitHub Runner 자동 다운로드 & 설치] 버튼을 눌러 설치해 주세요.", "설치 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.IsNullOrWhiteSpace(config.GitHubRepoUrl))
            {
                MessageBox.Show("먼저 좌측 상단 [GitHub 로그인 & 사용할 저장소 선택하기] 버튼으로 저장소를 연결해 주세요!", "저장소 연결 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string regToken = config.RunnerToken;

            // Auto-issue registration token via GitHub API if logged in!
            if (string.IsNullOrWhiteSpace(regToken) && !string.IsNullOrWhiteSpace(config.GitHubAccessToken) && !string.IsNullOrWhiteSpace(config.ConnectedRepoFullName))
            {
                try
                {
                    AppendConsole("[GitHub API] 연결된 계정 권한으로 Runner 등록 토큰을 자동 발급받는 중...", Color.Cyan);
                    string apiUrl = string.Format("https://api.github.com/repos/{0}/actions/runners/registration-token", config.ConnectedRepoFullName);
                    string respJson = await Task.Run(() => GitHubApiPost(apiUrl, config.GitHubAccessToken));
                    var dict = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(respJson);
                    if (dict != null && dict.ContainsKey("token"))
                    {
                        regToken = dict["token"].ToString();
                        AppendConsole("[GitHub API] Runner 등록 토큰 자동 발급 성공!", AccentGreen);
                    }
                }
                catch (Exception ex)
                {
                    AppendConsole("[GitHub API 안내] 공식 Runner 등록 토큰 발급 불가 (" + ex.Message + ").", AccentOrange);
                }
            }

            if (string.IsNullOrWhiteSpace(regToken))
            {
                var useApiPoller = MessageBox.Show(
                    "현재 로그인된 계정이 저장소 소유자(Owner/Admin)가 아닌 팀원(Collaborator) 권한이거나 Runner 등록 토큰이 없습니다.\n" +
                    "(GitHub 정책상 공식 Self-Hosted Runner 등록은 저장소 소유자 계정만 가능합니다.)\n\n" +
                    "★ 방장 권한이나 Runner 등록 없이도 내 API 토큰만으로 모든 브랜치의 build.yml 커밋/Actions를 실시간 감지해 자동으로 빌드하는\n" +
                    "[★ API 자동 감지 빌더]를 지금 바로 가동하시겠습니까?",
                    "팀원(Collaborator) 계정 자동 빌드 전환 안내",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information);

                if (useApiPoller == DialogResult.Yes)
                {
                    if (!isApiPolling) ToggleApiAutoPoller();
                    await ScanAllBranchesForWorkflowAsync(false);
                }
                else
                {
                    if (tabSettingsPage != null) tabMain.SelectedTab = tabSettingsPage;
                }
                return;
            }

            SetStatus("● GitHub Runner 등록 중...", AccentPurple);
            AppendConsole("=== 전용 PC를 GitHub 저장소(" + config.GitHubRepoUrl + ")의 Self-Hosted Runner로 등록합니다 ===", Color.Cyan);

            // 기존에 다른 저장소나 이전 설정으로 .runner 파일이 남아있으면 재등록이 막히므로 정리
            StopGitHubRunnerAgent();
            foreach (var oldCfg in new[] { ".runner", ".credentials", ".credentials_rsaparams", ".service" })
            {
                string oldPath = Path.Combine(config.RunnerDir, oldCfg);
                if (File.Exists(oldPath))
                {
                    try { File.Delete(oldPath); } catch { }
                }
            }

            string runnerName = Environment.MachineName + "-UE-Builder";
            string args = string.Format("--url \"{0}\" --token \"{1}\" --name \"{2}\" --work \"_work\" --unattended --replace",
                config.GitHubRepoUrl, regToken, runnerName);

            await Task.Run(() =>
            {
                RunProcessStream(configCmd, args, config.RunnerDir);
            });

            SetStatus("● 대기 중 (IDLE)", Color.FromArgb(52, 58, 64));
            UpdateRunnerStatusUI();

            // Runner 등록 직후 저장소의 모든 브랜치를 스캔하여 어느 브랜치에 build.yml이 있는지 자동 확인
            await ScanAllBranchesForWorkflowAsync(false);
        }

        private void StartGitHubRunnerAgent()
        {
            SaveConfigFromUI();
            string runCmd = Path.Combine(config.RunnerDir, "run.cmd");
            if (!File.Exists(runCmd))
            {
                MessageBox.Show("run.cmd를 찾을 수 없습니다. Runner 설치 및 등록을 먼저 진행해 주세요.", "오류", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c \"" + runCmd + "\"")
                {
                    WorkingDirectory = config.RunnerDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                runnerProcess = new Process { StartInfo = psi };
                runnerProcess.Start();

                Task.Run(() => EncodingHelper.ReadStreamLinesSmart(runnerProcess.StandardOutput.BaseStream, line => AppendConsole("[GitHub Runner] " + line, Color.Cyan)));
                Task.Run(() => EncodingHelper.ReadStreamLinesSmart(runnerProcess.StandardError.BaseStream, line => AppendConsole("[GitHub Runner] " + line, AccentOrange)));

                AppendConsole("▶ GitHub Actions Self-Hosted Runner가 백그라운드에서 가동을 시작했습니다!", AccentGreen);
                UpdateRunnerStatusUI();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Runner 실행 실패: " + ex.Message, "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void StopGitHubRunnerAgent()
        {
            try
            {
                if (runnerProcess != null && !runnerProcess.HasExited)
                {
                    using (var killProc = Process.Start(new ProcessStartInfo("taskkill", "/F /T /PID " + runnerProcess.Id)
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false
                    }))
                    {
                        if (killProc != null) killProc.WaitForExit(3000);
                    }
                }
                foreach (var p in Process.GetProcessesByName("Runner.Listener"))
                {
                    p.Kill();
                }
                AppendConsole("■ GitHub Actions Runner 가동이 중지되었습니다.", AccentOrange);
            }
            catch { }
            UpdateRunnerStatusUI();
        }

        // =====================================================================
        // Feature 1: Init Directories & Dynamic .gitignore Asset Junctions
        // =====================================================================
        private void InitDirectories()
        {
            SaveConfigFromUI();
            try
            {
                string[] dirs = new string[]
                {
                    config.RunnerDir,
                    @"C:\BuildSystem\Scripts",
                    config.SharedAssetsDir,
                    config.WorkspaceRoot,
                    Path.Combine(config.ArchiveRoot, "Logs"),
                    Path.Combine(config.ArchiveRoot, "Packages")
                };

                foreach (var d in dirs)
                {
                    if (!string.IsNullOrEmpty(d) && !Directory.Exists(d))
                        Directory.CreateDirectory(d);
                }

                SaveConfigFromUI();

                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                foreach (var sFile in new[] { "Run-UEBuild.ps1", "Send-SlackReport.ps1", "github_workflow_build.yml" })
                {
                    string src = Path.Combine(exeDir, sFile);
                    if (File.Exists(src))
                    {
                        byte[] raw = File.ReadAllBytes(src);
                        string text = EncodingHelper.DecodeSmartBytes(raw, raw.Length);
                        File.WriteAllText(Path.Combine(@"C:\BuildSystem\Scripts", sFile), text, EncodingHelper.Utf8WithBom);
                    }
                }

                AppendConsole("[초기 세팅] 필수 폴더 구조 및 스크립트 배치가 완료되었습니다.", AccentGreen);
                MessageBox.Show("필수 폴더 생성 및 스크립트 배치가 완료되었습니다!\n\n- GitHub Runner 폴더: " + config.RunnerDir + "\n- 워크스페이스 폴더: " + config.WorkspaceRoot + "\n- 로그/패키지 보관함: " + config.ArchiveRoot + "\n- 제외 에셋 원본 폴더: " + config.SharedAssetsDir, "완료", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("폴더 생성 중 오류 발생: " + ex.Message, "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private async Task CloneRepositoryAsync()
        {
            SaveConfigFromUI();
            if (string.IsNullOrWhiteSpace(config.GitRemoteUrl))
            {
                MessageBox.Show("먼저 좌측 상단 [GitHub 로그인 & 사용할 저장소 선택하기] 버튼을 눌러 저장소를 연결해 주세요!", "저장소 선택 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (string.IsNullOrWhiteSpace(config.ProjectDir))
            {
                string repoName = Path.GetFileNameWithoutExtension(config.GitRemoteUrl);
                config.ProjectDir = Path.Combine(config.WorkspaceRoot, repoName);
                txtProjectDir.Text = config.ProjectDir;
            }

            if (Directory.Exists(Path.Combine(config.ProjectDir, ".git")))
            {
                MessageBox.Show("이미 해당 경로에 Git 저장소가 존재합니다:\n" + config.ProjectDir, "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            string parentDir = Path.GetDirectoryName(config.ProjectDir);
            if (!Directory.Exists(parentDir)) Directory.CreateDirectory(parentDir);

            SetStatus("▼ Git Clone 진행 중...", AccentBlue);
            AppendConsole("=== 연결된 저장소 최초 Clone 시작: " + config.GitRemoteUrl + " ===", Color.Cyan);

            string cloneUrl = GetAuthenticatedCloneUrl();
            await Task.Run(() =>
            {
                RunProcessStream("git", string.Format("-c safe.directory=* -c core.quotepath=false clone \"{0}\" \"{1}\"", cloneUrl, config.ProjectDir), parentDir);
            });

            SetStatus("● 대기 중 (IDLE)", Color.FromArgb(52, 58, 64));
            UpdateCommitBanner();
            EnsureAssetJunctions(false);
        }

        private Dictionary<string, string> DiscoverIgnoredContentFolders()
        {
            var map = new Dictionary<string, string>();
            if (string.IsNullOrWhiteSpace(config.ProjectDir)) return map;

            string gitIgnore = Path.Combine(config.ProjectDir, ".gitignore");
            if (!File.Exists(gitIgnore)) return map;

            try
            {
                byte[] raw = File.ReadAllBytes(gitIgnore);
                string content = EncodingHelper.DecodeSmartBytes(raw, raw.Length);
                var lines = content.Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries);
                foreach (var line in lines)
                {
                    string trimmed = line.Trim();
                    var m = Regex.Match(trimmed, @"^Content/(.+?)(/\*)?$");
                    if (m.Success)
                    {
                        string relSub = m.Groups[1].Value.TrimEnd('/').Replace('/', '\\');
                        string targetLink = Path.Combine(config.ProjectDir, "Content", relSub);
                        string leafName = Path.GetFileName(targetLink);
                        string sourceDir = Path.Combine(config.SharedAssetsDir, leafName);
                        map[targetLink] = sourceDir;
                    }
                }
            }
            catch { }
            return map;
        }

        private void CheckAssetLinksSilent()
        {
            if (string.IsNullOrWhiteSpace(config.ProjectDir) || !Directory.Exists(config.ProjectDir))
            {
                lblAssetStatus.Text = "○ 에셋 링크 상태: 저장소 Clone 후 자동 감지됨";
                lblAssetStatus.ForeColor = FgSub;
                return;
            }

            var map = DiscoverIgnoredContentFolders();
            if (map.Count == 0)
            {
                lblAssetStatus.Text = "● .gitignore에 제외된 별도 Content 에셋 폴더 없음";
                lblAssetStatus.ForeColor = AccentGreen;
                return;
            }

            int linkedCount = map.Keys.Count(k => Directory.Exists(k));
            if (linkedCount == map.Count)
            {
                lblAssetStatus.Text = string.Format("● .gitignore 제외 에셋 {0}개 폴더 모두 연결됨", map.Count);
                lblAssetStatus.ForeColor = AccentGreen;
            }
            else
            {
                lblAssetStatus.Text = string.Format("✖ 제외 에셋 {0}개 중 {1}개 미연결 ([[3] 심볼릭 링크 연결] 클릭)", map.Count, map.Count - linkedCount);
                lblAssetStatus.ForeColor = Color.FromArgb(255, 120, 120);
            }
        }

        private void EnsureAssetJunctions(bool showPopup)
        {
            SaveConfigFromUI();
            var map = DiscoverIgnoredContentFolders();
            if (map.Count == 0)
            {
                CheckAssetLinksSilent();
                if (showPopup)
                    MessageBox.Show("현재 프로젝트의 .gitignore 파일에 'Content/...' 형태로 제외된 에셋 폴더가 없거나 아직 저장소가 Clone되지 않았습니다.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            StringBuilder report = new StringBuilder();
            foreach (var kv in map)
            {
                if (!Directory.Exists(kv.Value))
                    Directory.CreateDirectory(kv.Value);

                if (!Directory.Exists(kv.Key))
                {
                    string parent = Path.GetDirectoryName(kv.Key);
                    if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);

                    var psi = new ProcessStartInfo("cmd.exe", string.Format("/c mklink /J \"{0}\" \"{1}\"", kv.Key, kv.Value))
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true
                    };
                    using (var p = Process.Start(psi)) p.WaitForExit(3000);
                    report.AppendLine("✔ 심볼릭 링크 생성됨: " + kv.Key + " -> " + kv.Value);
                }
                else
                {
                    report.AppendLine("✔ 이미 연결되어 있음: " + kv.Key);
                }
            }

            CheckAssetLinksSilent();
            AppendConsole(report.ToString().TrimEnd(), AccentGreen);
            if (showPopup)
                MessageBox.Show(report.ToString(), ".gitignore 제외 에셋 자동 연결 완료", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void FetchBranchList()
        {
            SaveConfigFromUI();
            if (!string.IsNullOrWhiteSpace(config.ConnectedRepoFullName) && !string.IsNullOrWhiteSpace(config.GitHubAccessToken))
            {
                FetchBranchesViaGitHubApiAsync();
                return;
            }

            if (string.IsNullOrWhiteSpace(config.ProjectDir) || !Directory.Exists(Path.Combine(config.ProjectDir, ".git")))
            {
                MessageBox.Show("먼저 저장소를 연결하거나 Clone을 실행해 주세요.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                RunGitQuick("fetch --all --prune");
                string raw = RunGitQuick("branch -r");
                var branches = raw.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(b => b.Trim())
                    .Where(b => !b.Contains("->") && b.StartsWith("origin/"))
                    .Select(b => b.Substring("origin/".Length))
                    .Distinct()
                    .ToArray();

                if (branches.Length > 0)
                {
                    cboBranch.Items.Clear();
                    cboBranch.Items.AddRange(branches);
                    cboBranch.SelectedIndex = 0;
                    AppendConsole("[Git] 원격 브랜치 목록 갱신 완료: " + string.Join(", ", branches), Color.Cyan);
                }
            }
            catch (Exception ex)
            {
                AppendConsole("[Git 오류] 브랜치 목록 조회 실패: " + ex.Message, AccentRed);
            }
        }

        private async Task RunGitSyncAsync(string branch)
        {
            if (isBuilding)
            {
                MessageBox.Show("현재 빌드가 진행 중입니다.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            SaveConfigFromUI();
            if (string.IsNullOrWhiteSpace(config.ProjectDir) || !Directory.Exists(Path.Combine(config.ProjectDir, ".git")))
            {
                MessageBox.Show("워크스페이스에 Git 저장소가 없습니다. 먼저 [[2] 최초 Clone]을 실행해 주세요.", "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            SetStatus("▼ Git 동기화 중...", AccentBlue);
            AppendConsole(string.Format("\n=== [Git Sync] '{0}' 브랜치 최신 커밋으로 동기화 시작 ===", branch), Color.Cyan);

            string authedUrl = GetAuthenticatedCloneUrl();
            await Task.Run(() =>
            {
                if (!string.IsNullOrWhiteSpace(authedUrl))
                {
                    string remotes = RunGitQuick("remote");
                    bool hasOrigin = !string.IsNullOrWhiteSpace(remotes) &&
                        remotes.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Any(r => r.Trim() == "origin");
                    if (hasOrigin)
                        RunGitQuick(string.Format("remote set-url origin \"{0}\"", authedUrl));
                    else
                        RunGitQuick(string.Format("remote add origin \"{0}\"", authedUrl));
                }
                RunProcessStream("git", "-c safe.directory=* -c core.quotepath=false fetch --all --prune", config.ProjectDir);
                RunProcessStream("git", string.Format("-c safe.directory=* -c core.quotepath=false checkout -B \"{0}\" \"origin/{0}\"", branch), config.ProjectDir);
                RunProcessStream("git", string.Format("-c safe.directory=* -c core.quotepath=false reset --hard \"origin/{0}\"", branch), config.ProjectDir);
            });

            EnsureAssetJunctions(false);
            UpdateCommitBanner();
            SetStatus("● 대기 중 (IDLE)", Color.FromArgb(52, 58, 64));
        }

        // =====================================================================
        // Feature 2: UE Build & Package Execution (Auto-detects *.uproject)
        // =====================================================================
        private string FindUProjectFile()
        {
            if (string.IsNullOrWhiteSpace(config.ProjectDir) || !Directory.Exists(config.ProjectDir))
                return null;
            var files = Directory.GetFiles(config.ProjectDir, "*.uproject", SearchOption.TopDirectoryOnly);
            return files.Length > 0 ? files[0] : null;
        }

        private string GetSelectedClientConfig()
        {
            if (cboClientConfig != null && cboClientConfig.SelectedItem != null)
            {
                string txt = cboClientConfig.SelectedItem.ToString();
                if (txt.StartsWith("Shipping", StringComparison.OrdinalIgnoreCase)) return "Shipping";
                if (txt.StartsWith("DebugGame", StringComparison.OrdinalIgnoreCase)) return "DebugGame";
                return "Development";
            }
            if (!string.IsNullOrWhiteSpace(config.ClientConfig))
            {
                if (config.ClientConfig.StartsWith("Shipping", StringComparison.OrdinalIgnoreCase)) return "Shipping";
                if (config.ClientConfig.StartsWith("DebugGame", StringComparison.OrdinalIgnoreCase)) return "DebugGame";
            }
            return "Development";
        }

        private string GetSelectedQualityPresetName()
        {
            if (cboQualityPreset != null && cboQualityPreset.SelectedIndex >= 0)
            {
                return GameLauncherBuilder.IndexToPresetName(cboQualityPreset.SelectedIndex);
            }
            return string.IsNullOrWhiteSpace(config.DefaultQualityPreset) ? "Epic" : config.DefaultQualityPreset;
        }

        private string GetSelectedWindowModeName()
        {
            if (cboWindowMode != null && cboWindowMode.SelectedIndex >= 0)
            {
                if (cboWindowMode.SelectedIndex == 1) return "Fullscreen";
                if (cboWindowMode.SelectedIndex == 2) return "Windowed";
                return "WindowedFullscreen";
            }
            return string.IsNullOrWhiteSpace(config.DefaultWindowMode) ? "WindowedFullscreen" : config.DefaultWindowMode;
        }

        private int GetSelectedDefaultFps()
        {
            if (cboDefaultFps != null)
            {
                if (cboDefaultFps.SelectedIndex == 1) return 30;
                if (cboDefaultFps.SelectedIndex == 2) return 60;
                if (cboDefaultFps.SelectedIndex == 3) return 120;
                if (cboDefaultFps.SelectedIndex == 4) return 144;
                return 0;
            }
            return config.DefaultFrameRateLimit;
        }

        private void CreateLauncherInExistingFolderDialog()
        {
            SaveConfigFromUI();
            string startDir = Path.Combine(config.ArchiveRoot, "Packages");
            if (!Directory.Exists(startDir)) startDir = config.ArchiveRoot;

            using (var fbd = new FolderBrowserDialog
            {
                Description = "언리얼 패키징이 완료된 결과물 폴더(예: C:\\BuildArchive\\Packages\\빌드ID 또는 Windows 폴더)를 선택하세요.",
                SelectedPath = Directory.Exists(startDir) ? startDir : ""
            })
            {
                if (fbd.ShowDialog(this) != DialogResult.OK) return;

                string uproject = FindUProjectFile();
                string projHint = !string.IsNullOrEmpty(uproject) ? Path.GetFileNameWithoutExtension(uproject) : "";
                string launcherPath, err;
                bool ok = GameLauncherBuilder.GenerateLauncherInPackage(
                    fbd.SelectedPath,
                    projHint,
                    config.DefaultQualityPreset,
                    config.DefaultResolution,
                    config.DefaultWindowMode,
                    config.DefaultFrameRateLimit,
                    config.DefaultVSync,
                    out launcherPath,
                    out err);

                if (ok)
                {
                    AppendConsole("✔ [옵션 런처 생성 완료] " + launcherPath, AccentGreen);
                    var runNow = MessageBox.Show(
                        "패키징 폴더에 언리얼 그래픽 프리셋 & 해상도 선택 런처 생성이 완료되었습니다!\n\n" +
                        "▶ 생성 경로: " + launcherPath + "\n\n" +
                        "지금 바로 런처 화면을 띄워서 확인해 보시겠습니까?",
                        "게임 실행 옵션 런처 생성 완료",
                        MessageBoxButtons.YesNo,
                        MessageBoxIcon.Information);
                    if (runNow == DialogResult.Yes)
                    {
                        Process.Start(new ProcessStartInfo(launcherPath) { WorkingDirectory = Path.GetDirectoryName(launcherPath) });
                    }
                }
                else
                {
                    AppendConsole("[옵션 런처 생성 실패] " + err, AccentRed);
                    MessageBox.Show("런처 생성 실패:\n" + err, "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
        }

        private async void StartUEBuild(string mode, string branch)
        {
            await StartUEBuildAsync(mode, branch);
        }

        private async Task StartUEBuildAsync(string mode, string branch)
        {
            if (isBuilding)
            {
                MessageBox.Show("이미 빌드가 실행 중입니다!", "알림", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            SaveConfigFromUI();
            string runUat = Path.Combine(config.UE5Root, @"Engine\Build\BatchFiles\RunUAT.bat");
            string uproject = FindUProjectFile();

            if (!File.Exists(runUat))
            {
                MessageBox.Show("RunUAT.bat 파일을 찾을 수 없습니다:\n" + runUat + "\n\n[[5] 경로 & 토큰 설정] 탭에서 Unreal Engine 설치 경로를 확인해 주세요.", "경로 오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
                if (tabSettingsPage != null) tabMain.SelectedTab = tabSettingsPage;
                return;
            }
            if (string.IsNullOrEmpty(uproject) || !File.Exists(uproject))
            {
                MessageBox.Show("워크스페이스 경로에서 *.uproject 파일을 찾을 수 없습니다:\n" + config.ProjectDir + "\n\n먼저 저장소를 연결하고 [[3] 워크플로우 & 초기 세팅] 탭에서 [[2] 최초 Clone]을 실행해 주세요.", "경로 오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
                if (tabSetupPage != null) tabMain.SelectedTab = tabSetupPage;
                return;
            }

            string projectName = Path.GetFileNameWithoutExtension(uproject);

            isBuilding = true;
            currentBuildMode = mode;
            btnQuickVerify.Enabled = false;
            btnFullPackage.Enabled = false;
            btnStopBuild.Enabled = true;
            if (tabConsolePage != null) tabMain.SelectedTab = tabConsolePage;

            rtbConsole.Clear();
            rtbErrorsOnly.Clear();
            fullConsoleBuffer.Clear();

            EnsureAssetJunctions(false);

            string resolvedBranch = "";
            string commitHash = "";
            string commitAuthor = "";
            string commitMsg = "";
            await Task.Run(() => ResolveCommitMetadata(branch, out resolvedBranch, out commitHash, out commitAuthor, out commitMsg));
            UpdateCommitBanner();

            string safeBranch = Regex.Replace(string.IsNullOrWhiteSpace(resolvedBranch) ? "main" : resolvedBranch, @"[\\/:*?""<>|]", "_");
            string timestamp = DateTime.Now.ToString("yyyy-MM-dd_HHmmss");

            string buildId = string.Format("{0}_{1}_{2}_{3}", timestamp, mode, safeBranch, commitHash);
            currentLogArchiveDir = Path.Combine(config.ArchiveRoot, "Logs", buildId);
            Directory.CreateDirectory(currentLogArchiveDir);
            currentLogFilePath = Path.Combine(currentLogArchiveDir, "Full_UAT_Console.log");

            string uatArgs;
            string pkgOutDir = null;
            string clientCfg = GetSelectedClientConfig();
            if (mode == "QuickVerify")
            {
                SetStatus(string.Format("▶ 빠른 검증 빌드 ({0}) 진행 중...", clientCfg), AccentGreen);
                uatArgs = string.Format("BuildCookRun -project=\"{0}\" -noP4 -platform=Win64 -clientconfig={1} -build -cook -iterate -skipstage -utf8output", uproject, clientCfg);
            }
            else
            {
                SetStatus(string.Format("★ 전체 패키징 빌드 ({0}) 진행 중...", clientCfg), AccentBlue);
                pkgOutDir = Path.Combine(config.ArchiveRoot, "Packages", buildId);
                Directory.CreateDirectory(pkgOutDir);
                uatArgs = string.Format("BuildCookRun -project=\"{0}\" -noP4 -platform=Win64 -clientconfig={1} -build -cook -allmaps -stage -pak -archive -archivedirectory=\"{2}\" -utf8output", uproject, clientCfg, pkgOutDir);
            }

            AppendConsole(string.Format("=== [{0} - {1} ({2})] 빌드 시작 (브랜치: {3}, 커밋: {4} by {5}) ===", projectName, mode, clientCfg, safeBranch, commitHash, commitAuthor), Color.Cyan);
            AppendConsole("대상 프로젝트: " + uproject, FgSub);
            if (mode == "FullPackage")
            {
                AppendConsole(string.Format("패키징 그래픽/디스플레이 기본값: 프리셋={0}, 해상도={1}, 창모드={2}, 옵션런처동봉={3}",
                    config.DefaultQualityPreset, config.DefaultResolution, config.DefaultWindowMode, config.GenerateLauncherOnPackage ? "ON" : "OFF"), Color.FromArgb(145, 225, 175));
            }
            AppendConsole("로그 실시간 저장 경로: " + currentLogFilePath + "\n", FgSub);

            // 전체 패키징 시 Config/DefaultGameUserSettings.ini에 기본 그래픽 프리셋·해상도를 구워넣고 종료 후 원본 상태 복원
            string defaultGusPath = Path.Combine(config.ProjectDir, @"Config\DefaultGameUserSettings.ini");
            bool hadOrigGus = false;
            byte[] origGusBytes = null;
            if (mode == "FullPackage")
            {
                try
                {
                    string cfgDir = Path.GetDirectoryName(defaultGusPath);
                    if (!Directory.Exists(cfgDir)) Directory.CreateDirectory(cfgDir);
                    hadOrigGus = File.Exists(defaultGusPath);
                    if (hadOrigGus) origGusBytes = File.ReadAllBytes(defaultGusPath);
                    GameLauncherBuilder.WriteMergedGameUserSettingsIni(
                        defaultGusPath,
                        config.DefaultQualityPreset,
                        100,
                        config.DefaultResolution,
                        config.DefaultWindowMode,
                        config.DefaultFrameRateLimit,
                        config.DefaultVSync);
                }
                catch { }
            }

            buildStartTime = DateTime.Now;
            uiDurationTimer.Start();

            int exitCode = -1;
            try
            {
                exitCode = await Task.Run(() => RunUATWithLiveLog(runUat, uatArgs, config.ProjectDir, currentLogFilePath));
            }
            finally
            {
                if (mode == "FullPackage")
                {
                    try
                    {
                        if (hadOrigGus && origGusBytes != null)
                            File.WriteAllBytes(defaultGusPath, origGusBytes);
                        else if (!hadOrigGus && File.Exists(defaultGusPath))
                            File.Delete(defaultGusPath);
                    }
                    catch { }
                }
            }

            uiDurationTimer.Stop();
            var elapsed = DateTime.Now - buildStartTime;
            string durationStr = string.Format("{0:D2}분 {1:D2}초", (int)elapsed.TotalMinutes, elapsed.Seconds);

            await Task.Run(() => ArchiveUnrealInternalLogs(currentLogArchiveDir));
            ExtractErrorsToFile(currentLogFilePath, Path.Combine(currentLogArchiveDir, "Error_Summary.log"));

            isBuilding = false;
            btnQuickVerify.Enabled = true;
            btnFullPackage.Enabled = true;
            btnStopBuild.Enabled = false;
            RefreshHistoryList();

            if (exitCode == 0)
            {
                SetStatus("✔ 빌드 성공 (" + durationStr + ")", AccentGreen);
                AppendConsole(string.Format("\n✔ === 빌드/패키징이 성공적으로 완료되었습니다! (소요 시간: {0}) ===", durationStr), AccentGreen);

                if (mode == "FullPackage" && !string.IsNullOrEmpty(pkgOutDir) && Directory.Exists(pkgOutDir))
                {
                    if (config.GenerateLauncherOnPackage)
                    {
                        string launcherPath, launcherErr;
                        bool genOk = GameLauncherBuilder.GenerateLauncherInPackage(
                            pkgOutDir,
                            projectName,
                            config.DefaultQualityPreset,
                            config.DefaultResolution,
                            config.DefaultWindowMode,
                            config.DefaultFrameRateLimit,
                            config.DefaultVSync,
                            out launcherPath,
                            out launcherErr);
                        if (genOk)
                            AppendConsole("✔ [게임 실행 옵션 런처 동봉 완료] " + launcherPath, AccentGreen);
                        else
                            AppendConsole("[옵션 런처 생성 경고] " + launcherErr, AccentOrange);
                    }
                    else
                    {
                        GameLauncherBuilder.ApplyDefaultSettingsToPackageOnly(
                            pkgOutDir,
                            projectName,
                            config.DefaultQualityPreset,
                            config.DefaultResolution,
                            config.DefaultWindowMode,
                            config.DefaultFrameRateLimit,
                            config.DefaultVSync);
                    }
                }
            }
            else
            {
                SetStatus("✖ 빌드 실패 (ExitCode: " + exitCode + ")", AccentRed);
                AppendConsole(string.Format("\n[!] === 빌드/패키징 중 에러가 발생했습니다! (ExitCode: {0}, 소요 시간: {1}) ===", exitCode, durationStr), AccentRed);
                AppendConsole("하단 [핵심 에러 / 경고 발췌 뷰어]에서 정확한 실패 원인을 바로 확인하세요.", Color.Yellow);
            }

            if (chkAutoSlack.Checked && !string.IsNullOrWhiteSpace(config.SlackBotToken) && !string.IsNullOrWhiteSpace(config.SlackChannelId))
            {
                AppendConsole("\n[Slack] 빌드 결과 및 에러 로그를 Slack 채널로 전송 중...", Color.Cyan);
                await SendSlackReportAsync(projectName, exitCode, mode, safeBranch, commitHash, commitAuthor, commitMsg, durationStr, currentLogArchiveDir, currentLogFilePath);
            }
        }

        private int RunUATWithLiveLog(string exePath, string args, string workDir, string logFile)
        {
            try
            {
                using (var writer = new StreamWriter(logFile, false, EncodingHelper.Utf8WithBom))
                {
                    var psi = new ProcessStartInfo("cmd.exe", string.Format("/c \"\"{0}\" {1}\"", exePath, args))
                    {
                        WorkingDirectory = workDir,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        CreateNoWindow = true
                    };

                    activeProcess = new Process { StartInfo = psi };
                    activeProcess.Start();

                    var tOut = Task.Run(() =>
                    {
                        EncodingHelper.ReadStreamLinesSmart(activeProcess.StandardOutput.BaseStream, line =>
                        {
                            lock (writer) { writer.WriteLine(line); writer.Flush(); }
                            AppendConsole(line);
                        });
                    });

                    var tErr = Task.Run(() =>
                    {
                        EncodingHelper.ReadStreamLinesSmart(activeProcess.StandardError.BaseStream, line =>
                        {
                            lock (writer) { writer.WriteLine(line); writer.Flush(); }
                            AppendConsole(line, Color.FromArgb(255, 110, 110));
                        });
                    });

                    Task.WaitAll(tOut, tErr);
                    activeProcess.WaitForExit();
                    return activeProcess.ExitCode;
                }
            }
            catch (Exception ex)
            {
                AppendConsole("[실행 예외] " + ex.Message, AccentRed);
                return -1;
            }
            finally
            {
                activeProcess = null;
            }
        }

        private void StopActiveBuild()
        {
            if (activeProcess != null && !activeProcess.HasExited)
            {
                try
                {
                    using (var killProc = Process.Start(new ProcessStartInfo("taskkill", "/F /T /PID " + activeProcess.Id)
                    {
                        CreateNoWindow = true,
                        UseShellExecute = false
                    }))
                    {
                        if (killProc != null) killProc.WaitForExit(3000);
                    }
                    AppendConsole("\n■ 사용자에 의해 빌드가 강제 중단되었습니다.", AccentOrange);
                }
                catch (Exception ex)
                {
                    AppendConsole("중단 실패: " + ex.Message, AccentRed);
                }
            }
        }

        private void ArchiveUnrealInternalLogs(string destArchiveDir)
        {
            try
            {
                string savedLogs = Path.Combine(config.ProjectDir, @"Saved\Logs");
                if (Directory.Exists(savedLogs))
                {
                    string sub = Path.Combine(destArchiveDir, "Saved_Logs");
                    Directory.CreateDirectory(sub);
                    foreach (var f in Directory.GetFiles(savedLogs))
                        File.Copy(f, Path.Combine(sub, Path.GetFileName(f)), true);
                }

                string uatLogs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Unreal Engine\AutomationTool\Logs");
                if (Directory.Exists(uatLogs))
                {
                    string sub = Path.Combine(destArchiveDir, "Engine_UAT_Logs");
                    Directory.CreateDirectory(sub);
                    foreach (var f in Directory.GetFiles(uatLogs, "*", SearchOption.AllDirectories))
                    {
                        string target = Path.Combine(sub, Path.GetFileName(f));
                        File.Copy(f, target, true);
                    }
                }
            }
            catch { }
        }

        private List<string> ExtractErrorsToFile(string logFile, string summaryOutFile)
        {
            var matched = new List<string>();
            if (!File.Exists(logFile)) return matched;

            try
            {
                byte[] raw = File.ReadAllBytes(logFile);
                string content = EncodingHelper.DecodeSmartBytes(raw, raw.Length);
                var lines = content.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
                var regex = new Regex(@"error C\d+:|\bfatal error\b|Error:|Ensure condition failed|Unable to find plugin|Result: Failed|UnrealBuildTool failed|AutomationTool exiting with ExitCode", RegexOptions.IgnoreCase);
                for (int i = 0; i < lines.Length; i++)
                {
                    if (regex.IsMatch(lines[i]))
                    {
                        matched.Add(lines[i].Trim());
                    }
                }
                if (matched.Count > 0 && !string.IsNullOrEmpty(summaryOutFile))
                {
                    File.WriteAllLines(summaryOutFile, matched, EncodingHelper.Utf8WithBom);
                }
            }
            catch { }
            return matched;
        }

        private void ExtractAndShowErrors()
        {
            rtbErrorsOnly.Clear();
            var lines = fullConsoleBuffer.ToString().Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
            var regex = new Regex(@"error C\d+:|\bfatal error\b|Error:|Ensure condition failed|Unable to find plugin|Result: Failed|UnrealBuildTool failed|AutomationTool exiting with ExitCode", RegexOptions.IgnoreCase);
            int count = 0;
            foreach (var l in lines)
            {
                if (regex.IsMatch(l))
                {
                    rtbErrorsOnly.AppendText(l + Environment.NewLine);
                    count++;
                }
            }
            if (count == 0)
                rtbErrorsOnly.AppendText("✔ 현재 콘솔 로그에서 감지된 C++ 컴파일 / 쿠킹 에러가 없습니다.\n");
        }

        // =====================================================================
        // Feature 3: Slack Messaging & File Attachment Upload
        // =====================================================================
        private async Task SendSlackReportManualAsync()
        {
            SaveConfigFromUI();
            if (string.IsNullOrWhiteSpace(config.SlackBotToken) || string.IsNullOrWhiteSpace(config.SlackChannelId))
            {
                MessageBox.Show("[[5] 경로 & 토큰 설정] 탭에서 Slack Bot Token과 채널 ID를 먼저 입력해 주세요.", "설정 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                if (tabSettingsPage != null) tabMain.SelectedTab = tabSettingsPage;
                return;
            }
            if (string.IsNullOrEmpty(currentLogFilePath) || !File.Exists(currentLogFilePath))
            {
                MessageBox.Show("아직 실행된 빌드 로그 파일이 없습니다.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            string uproject = FindUProjectFile();
            string projectName = !string.IsNullOrEmpty(uproject) ? Path.GetFileNameWithoutExtension(uproject) : "UEProject";
            string resolvedBranch = "";
            string commitHash = "";
            string commitAuthor = "";
            string commitMsg = "";
            string uiBranch = cboBranch.Text.Trim();
            await Task.Run(() => ResolveCommitMetadata(uiBranch, out resolvedBranch, out commitHash, out commitAuthor, out commitMsg));

            AppendConsole("[Slack] 수동 로그 리포트 전송 시작...", Color.Cyan);
            await SendSlackReportAsync(projectName, 1, currentBuildMode, resolvedBranch, commitHash, commitAuthor, commitMsg, "수동 전송", currentLogArchiveDir, currentLogFilePath);
        }

        private async Task SendSlackReportAsync(string projectName, int exitCode, string mode, string branch, string hash, string author, string msg, string duration, string archiveDir, string uatLogFile)
        {
            await Task.Run(() =>
            {
                try
                {
                    string clientCfg = GetSelectedClientConfig();
                    string modeLabel = ((mode == "QuickVerify") ? "빠른 컴파일·쿠킹 검증" : "전체 패키징 빌드") + " [" + clientCfg + "]";
                    string tsIp = GetServerIPv4ForSlack();
                    string sharedPath = Regex.Replace(archiveDir, @"^[A-Za-z]:\\BuildArchive", @"\\" + tsIp + @"\BuildArchive", RegexOptions.IgnoreCase);

                    if (exitCode == 0)
                    {
                        string extraPkgInfo = "";
                        if (mode == "FullPackage")
                        {
                            string pkgSharePath = sharedPath.Replace(@"\BuildArchive\Logs\", @"\BuildArchive\Packages\");
                            extraPkgInfo = string.Format("\n• *패키징 결과물 폴더:* `{0}`\n• *실행 옵션:* `{1}_Launcher.exe` (그래픽 프리셋 {2} / {3} 선택 실행기 동봉)",
                                pkgSharePath, projectName, config.DefaultQualityPreset, config.DefaultResolution);
                        }
                        string okMsg = string.Format("*[{0} 빌드 성공]* ({1} 완료)\n• *브랜치/커밋:* `{2}` (`{3}`) by *{4}*\n• *커밋 메시지:* {5}\n• *소요 시간:* {6}\n• *로그 공유 폴더:* `{7}`{8}",
                            projectName, modeLabel, branch, hash, author, msg, duration, sharedPath, extraPkgInfo);
                        PostSlackChatMessage(okMsg);
                        AppendConsole("[Slack] 성공 알림 전송 완료!", AccentGreen);
                        return;
                    }

                    var errLines = ExtractErrorsToFile(uatLogFile, null);
                    if (errLines.Count > 25)
                        errLines = errLines.Skip(errLines.Count - 25).ToList();

                    string snippet = errLines.Count > 0 ? string.Join("\n", errLines) : "상세 내용은 첨부된 원본 로그 파일을 확인해 주세요.";
                    if (snippet.Length > 2500) snippet = snippet.Substring(snippet.Length - 2500);

                    string failMsg = string.Format(
                        "*[{0} 빌드/패키징 실패]* ({1})\n• *브랜치 / 커밋:* `{2}` (`{3}`)\n• *작성자:* *{4}*\n• *커밋 메시지:* {5}\n• *소요 시간:* {6}\n• *전체 로그 공유폴더:* `{7}`\n\n*[에러 발생 당시 핵심 로그 발췌]*\n```\n{8}\n```",
                        projectName, modeLabel, branch, hash, author, msg, duration, sharedPath, snippet);

                    PostSlackChatMessage(failMsg);

                    if (File.Exists(uatLogFile))
                    {
                        UploadFileToSlackV2(uatLogFile, string.Format("ErrorLog_{0}_{1}_{2}.log", projectName, branch, hash));
                    }
                    AppendConsole("[Slack] 에러 요약 코드블록 및 원본 .log 파일 첨부 전송 완료!", AccentGreen);
                }
                catch (Exception ex)
                {
                    AppendConsole("[Slack 전송 실패] " + ex.Message, AccentRed);
                }
            });
        }

        private void PostSlackChatMessage(string text)
        {
            var serializer = new JavaScriptSerializer();
            string payload = serializer.Serialize(new { channel = config.SlackChannelId, text = text });
            byte[] bytes = Encoding.UTF8.GetBytes(payload);

            var req = (HttpWebRequest)WebRequest.Create("https://slack.com/api/chat.postMessage");
            req.Method = "POST";
            req.ContentType = "application/json; charset=utf-8";
            req.Headers.Add("Authorization", "Bearer " + config.SlackBotToken);
            using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            using (var resp = req.GetResponse()) { }
        }

        private void UploadFileToSlackV2(string filePath, string uploadFileName)
        {
            byte[] fileBytes = File.ReadAllBytes(filePath);
            var serializer = new JavaScriptSerializer();

            string url1 = string.Format("https://slack.com/api/files.getUploadURLExternal?filename={0}&length={1}",
                Uri.EscapeDataString(uploadFileName), fileBytes.Length);
            var req1 = (HttpWebRequest)WebRequest.Create(url1);
            req1.Method = "GET";
            req1.Headers.Add("Authorization", "Bearer " + config.SlackBotToken);

            string resp1Json;
            using (var r1 = req1.GetResponse())
            using (var sr = new StreamReader(r1.GetResponseStream(), Encoding.UTF8))
                resp1Json = sr.ReadToEnd();

            var dict1 = serializer.Deserialize<Dictionary<string, object>>(resp1Json);
            if (dict1 == null || !dict1.ContainsKey("ok") || !(bool)dict1["ok"]) return;

            string uploadUrl = dict1["upload_url"].ToString();
            string fileId = dict1["file_id"].ToString();

            var req2 = (HttpWebRequest)WebRequest.Create(uploadUrl);
            req2.Method = "POST";
            req2.ContentType = "application/octet-stream";
            using (var s2 = req2.GetRequestStream()) s2.Write(fileBytes, 0, fileBytes.Length);
            using (var r2 = req2.GetResponse()) { }

            string completePayload = serializer.Serialize(new
            {
                files = new[] { new { id = fileId, title = "원본 빌드/패키징 로그 (" + uploadFileName + ")" } },
                channel_id = config.SlackChannelId,
                initial_comment = "*작업 PC에서 바로 열람 가능한 에러 발생 당시 원본 .log 파일입니다.*"
            });
            byte[] body3 = Encoding.UTF8.GetBytes(completePayload);

            var req3 = (HttpWebRequest)WebRequest.Create("https://slack.com/api/files.completeUploadExternal");
            req3.Method = "POST";
            req3.ContentType = "application/json; charset=utf-8";
            req3.Headers.Add("Authorization", "Bearer " + config.SlackBotToken);
            using (var s3 = req3.GetRequestStream()) s3.Write(body3, 0, body3.Length);
            using (var r3 = req3.GetResponse()) { }
        }

        private async Task TestSlackConnectionAsync()
        {
            SaveConfigFromUI();
            if (string.IsNullOrWhiteSpace(config.SlackBotToken) || string.IsNullOrWhiteSpace(config.SlackChannelId))
            {
                MessageBox.Show("Slack Bot Token과 채널 ID를 입력해 주세요.", "입력 필요", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                await Task.Run(() =>
                {
                    PostSlackChatMessage("*[UE 빌드 매니저]* 전용 빌드 PC(GitHub Actions Runner)와 Slack 채널 연동 테스트가 성공했습니다!");
                });
                MessageBox.Show("Slack 채널로 테스트 메시지가 전송되었습니다! Slack 앱을 확인해 보세요.", "연동 성공", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Slack 전송 실패: " + ex.Message, "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        // =====================================================================
        // Helpers: History, Tailscale IP, Process Runner
        // =====================================================================
        private void RefreshHistoryList()
        {
            if (lvHistory == null) return;
            lvHistory.Items.Clear();
            string logsRoot = Path.Combine(config.ArchiveRoot, "Logs");
            if (!Directory.Exists(logsRoot)) return;

            var dirs = new DirectoryInfo(logsRoot).GetDirectories().OrderByDescending(d => d.CreationTime);
            foreach (var d in dirs)
            {
                string mode = d.Name.Contains("FullPackage") ? "[전체 패키징]" : "[빠른 검증]";
                bool hasErr = File.Exists(Path.Combine(d.FullName, "Error_Summary.log"));
                var item = new ListViewItem(d.Name);
                item.SubItems.Add(mode);
                item.SubItems.Add(d.CreationTime.ToString("yyyy-MM-dd HH:mm:ss"));
                item.SubItems.Add(hasErr ? "[!] 에러 있음" : "✔ 정상");
                item.SubItems.Add(d.FullName);
                item.Tag = d.FullName;
                if (hasErr) item.ForeColor = Color.FromArgb(255, 130, 130);
                lvHistory.Items.Add(item);
            }
        }

        private void OpenSelectedHistoryLog(bool errorSummaryOnly)
        {
            if (lvHistory.SelectedItems.Count == 0)
            {
                MessageBox.Show("목록에서 빌드 기록을 먼저 선택해 주세요.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string dir = lvHistory.SelectedItems[0].Tag.ToString();
            string file = Path.Combine(dir, errorSummaryOnly ? "Error_Summary.log" : "Full_UAT_Console.log");
            if (File.Exists(file))
                Process.Start("notepad.exe", file);
            else
                MessageBox.Show("해당 로그 파일이 존재하지 않습니다:\n" + file, "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private string GetServerIPv4ForSlack()
        {
            if (!string.IsNullOrWhiteSpace(config.TailscaleIP))
                return config.TailscaleIP.Trim();

            string detected = DetectActiveIPv4Address();
            return !string.IsNullOrWhiteSpace(detected) ? detected : Environment.MachineName;
        }

        private string DetectActiveIPv4Address()
        {
            // 1순위: OS 라우팅 테이블 기준 실제 외부/내부망 통신에 사용 중인 주 IPv4 주소 조회 (패킷 전송 없음)
            try
            {
                using (Socket socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, 0))
                {
                    socket.Connect("8.8.8.8", 65530);
                    IPEndPoint endPoint = socket.LocalEndPoint as IPEndPoint;
                    if (endPoint != null)
                    {
                        string routeIp = endPoint.Address.ToString();
                        if (!string.IsNullOrWhiteSpace(routeIp) && !routeIp.StartsWith("127.") && !routeIp.StartsWith("169.254."))
                            return routeIp;
                    }
                }
            }
            catch { }

            // 2순위: 활성화된(Up) 네트워크 인터페이스 중 게이트웨이가 있는 실제 LAN IPv4 주소 탐색
            try
            {
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                        continue;

                    var ipProps = ni.GetIPProperties();
                    bool hasGateway = ipProps.GatewayAddresses != null && ipProps.GatewayAddresses.Count > 0;
                    if (!hasGateway) continue;

                    foreach (var ua in ipProps.UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                        {
                            string ip = ua.Address.ToString();
                            if (!ip.StartsWith("127.") && !ip.StartsWith("169.254."))
                                return ip;
                        }
                    }
                }

                // 3순위: 게이트웨이 유무와 무관하게 Up 상태인 IPv4 주소 (Tailscale 100.x.y.z 또는 사설망 IP)
                foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                        continue;

                    foreach (var ua in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ua.Address.AddressFamily == AddressFamily.InterNetwork)
                        {
                            string ip = ua.Address.ToString();
                            if (!ip.StartsWith("127.") && !ip.StartsWith("169.254."))
                                return ip;
                        }
                    }
                }
            }
            catch { }

            return "";
        }

        private void DetectTailscaleIP()
        {
            try
            {
                string activeIpv4 = DetectActiveIPv4Address();
                if (!string.IsNullOrWhiteSpace(activeIpv4))
                {
                    MessageBox.Show(
                        "현재 빌드 서버 장치에서 자동 감지된 IPv4 주소:\n\n" +
                        "▶ " + activeIpv4 + "\n\n" +
                        "(입력 칸을 비워 두셔도 빌드 완료 시 위 IPv4 주소를 자동으로 읽어와 Slack 메시지의 공유 폴더 경로에 넣어 전송합니다!)",
                        "장치 IPv4 자동 감지 확인", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                MessageBox.Show("현재 PC에서 활성화된 IPv4 네트워크 주소를 찾지 못했습니다.", "알림", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("IP 감지 실패: " + ex.Message, "오류", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void RunProcessStream(string fileName, string args, string workDir)
        {
            try
            {
                var psi = new ProcessStartInfo(fileName, args)
                {
                    WorkingDirectory = workDir,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var p = Process.Start(psi))
                {
                    var tOut = Task.Run(() => EncodingHelper.ReadStreamLinesSmart(p.StandardOutput.BaseStream, line => AppendConsole(line)));
                    var tErr = Task.Run(() => EncodingHelper.ReadStreamLinesSmart(p.StandardError.BaseStream, line => AppendConsole(line)));
                    Task.WaitAll(tOut, tErr);
                    p.WaitForExit();
                }
            }
            catch (Exception ex)
            {
                AppendConsole("[오류] " + ex.Message, AccentRed);
            }
        }

        private void OpenFolderSafe(string path)
        {
            try
            {
                if (!Directory.Exists(path)) Directory.CreateDirectory(path);
                Process.Start("explorer.exe", path);
            }
            catch (Exception ex)
            {
                MessageBox.Show("폴더 열기 실패: " + ex.Message);
            }
        }
    }

    public static class GameLauncherBuilder
    {
        private static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false);

        public static int PresetNameToIndex(string preset)
        {
            if (string.IsNullOrWhiteSpace(preset)) return 3;
            string p = preset.Trim();
            if (p.StartsWith("Low", StringComparison.OrdinalIgnoreCase)) return 0;
            if (p.StartsWith("Medium", StringComparison.OrdinalIgnoreCase)) return 1;
            if (p.StartsWith("High", StringComparison.OrdinalIgnoreCase)) return 2;
            if (p.StartsWith("Cinematic", StringComparison.OrdinalIgnoreCase)) return 4;
            return 3; // Epic
        }

        public static string IndexToPresetName(int idx)
        {
            switch (idx)
            {
                case 0: return "Low";
                case 1: return "Medium";
                case 2: return "High";
                case 4: return "Cinematic";
                default: return "Epic";
            }
        }

        public static int WindowModeNameToUeMode(string winMode)
        {
            if (string.IsNullOrWhiteSpace(winMode)) return 1; // WindowedFullscreen
            if (winMode.Equals("Fullscreen", StringComparison.OrdinalIgnoreCase)) return 0;
            if (winMode.Equals("Windowed", StringComparison.OrdinalIgnoreCase)) return 2;
            return 1;
        }

        public static void ParseResolution(string res, out int w, out int h)
        {
            w = 1920;
            h = 1080;
            if (string.IsNullOrWhiteSpace(res)) return;
            var m = Regex.Match(res, @"(\d{3,5})\s*[xX]\s*(\d{3,5})");
            if (m.Success)
            {
                int.TryParse(m.Groups[1].Value, out w);
                int.TryParse(m.Groups[2].Value, out h);
            }
        }

        public static void WriteMergedGameUserSettingsIni(
            string iniPath,
            string qualityPreset,
            int resQualityScale,
            string resolution,
            string windowMode,
            int fpsLimit,
            bool vsync)
        {
            int q = PresetNameToIndex(qualityPreset);
            int w, h;
            ParseResolution(resolution, out w, out h);
            int fsMode = WindowModeNameToUeMode(windowMode);

            StringBuilder preserved = new StringBuilder();
            if (File.Exists(iniPath))
            {
                try
                {
                    string existing = File.ReadAllText(iniPath, Encoding.UTF8);
                    string[] lines = existing.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
                    bool skipSection = false;
                    foreach (var rawLine in lines)
                    {
                        string trimmed = rawLine.Trim();
                        if (trimmed.StartsWith("[") && trimmed.EndsWith("]"))
                        {
                            skipSection = trimmed.Equals("[ScalabilityGroups]", StringComparison.OrdinalIgnoreCase) ||
                                          trimmed.Equals("[/Script/Engine.GameUserSettings]", StringComparison.OrdinalIgnoreCase);
                        }
                        if (!skipSection && trimmed.Length > 0)
                        {
                            preserved.AppendLine(rawLine);
                        }
                    }
                }
                catch { }
            }

            StringBuilder sb = new StringBuilder();
            if (preserved.Length > 0)
            {
                sb.Append(preserved.ToString().TrimEnd());
                sb.AppendLine();
                sb.AppendLine();
            }

            sb.AppendLine("[ScalabilityGroups]");
            sb.AppendFormat("sg.ResolutionQuality={0}\r\n", resQualityScale);
            sb.AppendFormat("sg.ViewDistanceQuality={0}\r\n", q);
            sb.AppendFormat("sg.AntiAliasingQuality={0}\r\n", q);
            sb.AppendFormat("sg.ShadowQuality={0}\r\n", q);
            sb.AppendFormat("sg.GlobalIlluminationQuality={0}\r\n", q);
            sb.AppendFormat("sg.ReflectionsQuality={0}\r\n", q);
            sb.AppendFormat("sg.PostProcessQuality={0}\r\n", q);
            sb.AppendFormat("sg.TextureQuality={0}\r\n", q);
            sb.AppendFormat("sg.EffectsQuality={0}\r\n", q);
            sb.AppendFormat("sg.FoliageQuality={0}\r\n", q);
            sb.AppendFormat("sg.ShadingQuality={0}\r\n", q);
            sb.AppendFormat("sg.LandscapeQuality={0}\r\n", q);
            sb.AppendLine();
            sb.AppendLine("[/Script/Engine.GameUserSettings]");
            sb.AppendFormat("bUseVSync={0}\r\n", vsync ? "True" : "False");
            sb.AppendLine("bUseDynamicResolution=False");
            sb.AppendFormat("ResolutionSizeX={0}\r\n", w);
            sb.AppendFormat("ResolutionSizeY={0}\r\n", h);
            sb.AppendFormat("LastUserConfirmedResolutionSizeX={0}\r\n", w);
            sb.AppendFormat("LastUserConfirmedResolutionSizeY={0}\r\n", h);
            sb.AppendLine("WindowPosX=-1");
            sb.AppendLine("WindowPosY=-1");
            sb.AppendFormat("FullscreenMode={0}\r\n", fsMode);
            sb.AppendFormat("LastConfirmedFullscreenMode={0}\r\n", fsMode);
            sb.AppendFormat("PreferredFullscreenMode={0}\r\n", fsMode);
            sb.AppendLine("Version=5");
            sb.AppendLine("AudioQualityLevel=0");
            sb.AppendLine("LastConfirmedAudioQualityLevel=0");
            sb.AppendFormat("FrameRateLimit={0}.000000\r\n", fpsLimit <= 0 ? 0 : fpsLimit);
            sb.AppendFormat("DesiredScreenWidth={0}\r\n", w);
            sb.AppendFormat("DesiredScreenHeight={0}\r\n", h);
            sb.AppendLine("bUseDesiredScreenHeight=True");
            sb.AppendFormat("LastUserConfirmedDesiredScreenWidth={0}\r\n", w);
            sb.AppendFormat("LastUserConfirmedDesiredScreenHeight={0}\r\n", h);

            string parent = Path.GetDirectoryName(iniPath);
            if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent))
                Directory.CreateDirectory(parent);
            File.WriteAllText(iniPath, sb.ToString(), Utf8NoBom);
        }

        public static string FindPackagedGameRoot(string packageDir, ref string projectName)
        {
            if (string.IsNullOrWhiteSpace(packageDir) || !Directory.Exists(packageDir))
                return null;

            string[] candidateSubDirs = new[]
            {
                packageDir,
                Path.Combine(packageDir, "Windows"),
                Path.Combine(packageDir, "WindowsClient"),
                Path.Combine(packageDir, "WindowsNoEditor")
            };

            if (!string.IsNullOrWhiteSpace(projectName))
            {
                foreach (var sub in candidateSubDirs)
                {
                    if (Directory.Exists(sub) && File.Exists(Path.Combine(sub, projectName + ".exe")))
                        return sub;
                }
            }

            foreach (var sub in candidateSubDirs)
            {
                if (!Directory.Exists(sub)) continue;
                var exes = Directory.GetFiles(sub, "*.exe", SearchOption.TopDirectoryOnly)
                    .Where(f =>
                    {
                        string fn = Path.GetFileName(f);
                        return !fn.EndsWith("_Launcher.exe", StringComparison.OrdinalIgnoreCase) &&
                               !fn.StartsWith("UEPrereqSetup", StringComparison.OrdinalIgnoreCase) &&
                               !fn.StartsWith("CrashReportClient", StringComparison.OrdinalIgnoreCase);
                    })
                    .ToArray();
                if (exes.Length > 0)
                {
                    if (string.IsNullOrWhiteSpace(projectName))
                        projectName = Path.GetFileNameWithoutExtension(exes[0]);
                    return sub;
                }
            }

            return Directory.Exists(Path.Combine(packageDir, "Windows")) ? Path.Combine(packageDir, "Windows") : packageDir;
        }

        public static void ApplyDefaultSettingsToPackageOnly(
            string packageDir,
            string projectName,
            string defaultPreset,
            string defaultRes,
            string defaultWinMode,
            int defaultFps,
            bool defaultVSync)
        {
            string proj = projectName;
            string gameRoot = FindPackagedGameRoot(packageDir, ref proj);
            if (string.IsNullOrEmpty(gameRoot) || string.IsNullOrEmpty(proj)) return;
            string savedIni = Path.Combine(gameRoot, proj, @"Saved\Config\Windows\GameUserSettings.ini");
            WriteMergedGameUserSettingsIni(savedIni, defaultPreset, 100, defaultRes, defaultWinMode, defaultFps, defaultVSync);
        }

        public static bool GenerateLauncherInPackage(
            string packageDir,
            string projectName,
            string defaultPreset,
            string defaultRes,
            string defaultWinMode,
            int defaultFps,
            bool defaultVSync,
            out string launcherExePath,
            out string errorMessage)
        {
            launcherExePath = "";
            errorMessage = "";

            try
            {
                string proj = projectName;
                string gameRoot = FindPackagedGameRoot(packageDir, ref proj);
                if (string.IsNullOrEmpty(gameRoot) || !Directory.Exists(gameRoot))
                {
                    errorMessage = "패키징 폴더 경로를 찾을 수 없습니다: " + packageDir;
                    return false;
                }
                if (string.IsNullOrWhiteSpace(proj))
                    proj = "UEGame";

                // 1. 패키징 폴더 내 기본 GameUserSettings.ini 사전 생성
                string savedIni = Path.Combine(gameRoot, proj, @"Saved\Config\Windows\GameUserSettings.ini");
                WriteMergedGameUserSettingsIni(savedIni, defaultPreset, 100, defaultRes, defaultWinMode, defaultFps, defaultVSync);

                // 2. 런처 기본 선택값 준비
                int presetIdx = PresetNameToIndex(defaultPreset);
                int winModeUiIdx = 0; // 0: 테두리없는창, 1: 전체화면, 2: 창모드
                if (string.Equals(defaultWinMode, "Fullscreen", StringComparison.OrdinalIgnoreCase)) winModeUiIdx = 1;
                else if (string.Equals(defaultWinMode, "Windowed", StringComparison.OrdinalIgnoreCase)) winModeUiIdx = 2;

                string safeProjLiteral = proj.Replace("\\", "\\\\").Replace("\"", "\\\"");
                string safeResLiteral = (string.IsNullOrWhiteSpace(defaultRes) ? "1920x1080" : defaultRes.Trim()).Replace("\"", "");

                string launcherSource = GetLauncherSourceTemplate()
                    .Replace("__PROJECT_NAME__", safeProjLiteral)
                    .Replace("__DEFAULT_PRESET_IDX__", presetIdx.ToString())
                    .Replace("__DEFAULT_RES__", safeResLiteral)
                    .Replace("__DEFAULT_WINMODE_IDX__", winModeUiIdx.ToString())
                    .Replace("__DEFAULT_FPS__", (defaultFps <= 0 ? 0 : defaultFps).ToString())
                    .Replace("__DEFAULT_VSYNC__", defaultVSync ? "true" : "false");

                launcherExePath = Path.Combine(gameRoot, proj + "_Launcher.exe");
                string tempCs = Path.Combine(Path.GetTempPath(), "UELauncher_" + Guid.NewGuid().ToString("N") + ".cs");
                try
                {
                    File.WriteAllText(tempCs, launcherSource, EncodingHelper.Utf8WithBom);
                    using (var provider = new CSharpCodeProvider())
                    {
                        var cp = new CompilerParameters
                        {
                            GenerateExecutable = true,
                            OutputAssembly = launcherExePath,
                            GenerateInMemory = false,
                            TreatWarningsAsErrors = false,
                            CompilerOptions = "/target:winexe /optimize+ /codepage:65001"
                        };
                        cp.ReferencedAssemblies.Add("System.dll");
                        cp.ReferencedAssemblies.Add("System.Core.dll");
                        cp.ReferencedAssemblies.Add("System.Drawing.dll");
                        cp.ReferencedAssemblies.Add("System.Windows.Forms.dll");

                        CompilerResults cr = provider.CompileAssemblyFromFile(cp, tempCs);
                        if (cr.Errors.HasErrors)
                        {
                            StringBuilder errSb = new StringBuilder();
                            foreach (CompilerError ce in cr.Errors)
                            {
                                if (!ce.IsWarning)
                                    errSb.AppendLine(string.Format("Line {0}: {1}", ce.Line, ce.ErrorText));
                            }
                            errorMessage = errSb.ToString().Trim();
                            return false;
                        }
                    }
                }
                finally
                {
                    if (File.Exists(tempCs))
                    {
                        try { File.Delete(tempCs); } catch { }
                    }
                }

                return File.Exists(launcherExePath);
            }
            catch (Exception ex)
            {
                errorMessage = ex.Message;
                return false;
            }
        }

        private static string GetLauncherSourceTemplate()
        {
            return @"using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace UEGameLauncher
{
    public class LauncherForm : Form
    {
        private const string ProjectName = ""__PROJECT_NAME__"";
        private ComboBox cboPreset;
        private Label lblPresetDesc;
        private ComboBox cboResScale;
        private ComboBox cboResolution;
        private ComboBox cboWindowMode;
        private ComboBox cboFpsLimit;
        private CheckBox chkVSync;

        private readonly Color BgDark = Color.FromArgb(24, 26, 31);
        private readonly Color BgCard = Color.FromArgb(34, 38, 46);
        private readonly Color BgInput = Color.FromArgb(46, 51, 61);
        private readonly Color FgText = Color.FromArgb(235, 239, 245);
        private readonly Color FgSub = Color.FromArgb(165, 175, 190);
        private readonly Color AccentGreen = Color.FromArgb(40, 180, 99);
        private readonly Color AccentBlue = Color.FromArgb(56, 132, 255);

        private readonly string[] PresetDescriptions = new string[]
        {
            ""▶ [Low 0단계] 루멘 GI·그림자·이펙트를 최소화하여 저사양/내장그래픽에서도 최고 프레임을 확보합니다."",
            ""▶ [Medium 1단계] 발열과 GPU 부하를 낮추면서 깔끔한 화면을 유지하는 밸런스 프리셋입니다."",
            ""▶ [High 2단계] 고품질 라이팅·그림자·반사 효과를 활성화한 고사양 권장 프리셋입니다."",
            ""▶ [Epic 3단계] 언리얼 엔진 5 표준 최고 그래픽 프리셋 (루멘 GI·고해상도 텍스처·이펙트 전체 활성)"",
            ""▶ [Cinematic 4단계] 실시간 플레이보다 영상 촬영·시연용 극한 품질에 맞춘 최고 부하 프리셋입니다.""
        };

        public LauncherForm()
        {
            this.Text = ProjectName + "" — 실행 및 그래픽 옵션 설정"";
            this.ClientSize = new Size(480, 465);
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.BackColor = BgDark;
            this.ForeColor = FgText;
            this.Font = new Font(""Malgun Gothic"", 9.5f, FontStyle.Regular);

            BuildUI();
            LoadLastPrefs();
        }

        private void BuildUI()
        {
            Panel pnlHeader = new Panel
            {
                Dock = DockStyle.Top,
                Height = 68,
                BackColor = BgCard,
                Padding = new Padding(18, 12, 18, 10)
            };

            Label lblTitle = new Label
            {
                Text = ""▶ "" + ProjectName + "" 실행 옵션 런처"",
                Font = new Font(""Malgun Gothic"", 13f, FontStyle.Bold),
                ForeColor = Color.White,
                Location = new Point(18, 11),
                AutoSize = true
            };
            Label lblSub = new Label
            {
                Text = ""언리얼 엔진 기본 그래픽 프리셋(Scalability) 및 해상도·창 모드를 선택하세요."",
                Font = new Font(""Malgun Gothic"", 8.8f),
                ForeColor = FgSub,
                Location = new Point(20, 40),
                AutoSize = true
            };
            pnlHeader.Controls.Add(lblTitle);
            pnlHeader.Controls.Add(lblSub);
            this.Controls.Add(pnlHeader);

            int y = 84;

            // 1. 그래픽 프리셋
            AddRowLabel(""그래픽 품질 프리셋:"", y);
            cboPreset = CreateCombo(new Point(158, y), 300);
            cboPreset.Items.AddRange(new object[]
            {
                ""낮음 (Low) — 최고 프레임 / 저사양"",
                ""중간 (Medium) — 발열 감소 / 밸런스"",
                ""높음 (High) — 고품질 그래픽"",
                ""에픽 (Epic) — 언리얼 권장 최고 품질"",
                ""시네마틱 (Cinematic) — 시연·촬영용 극한 품질""
            });
            cboPreset.SelectedIndex = __DEFAULT_PRESET_IDX__;
            cboPreset.SelectedIndexChanged += (s, e) => UpdatePresetDesc();
            this.Controls.Add(cboPreset);
            y += 31;

            lblPresetDesc = new Label
            {
                Location = new Point(20, y),
                Size = new Size(440, 34),
                ForeColor = Color.FromArgb(140, 210, 255),
                Font = new Font(""Malgun Gothic"", 8.3f)
            };
            this.Controls.Add(lblPresetDesc);
            UpdatePresetDesc();
            y += 40;

            // 2. 3D 렌더링 스케일
            AddRowLabel(""3D 렌더링 선명도:"", y);
            cboResScale = CreateCombo(new Point(158, y), 300);
            cboResScale.Items.AddRange(new object[]
            {
                ""100% (원본 해상도 선명도 - 권장)"",
                ""85% (고프레임 업스케일)"",
                ""75% (성능 우선)"",
                ""50% (초저사양 모드)""
            });
            cboResScale.SelectedIndex = 0;
            this.Controls.Add(cboResScale);
            y += 38;

            // 3. 화면 해상도
            AddRowLabel(""화면 해상도:"", y);
            cboResolution = CreateCombo(new Point(158, y), 300);
            List<string> resItems = new List<string>
            {
                ""1280 x 720 (HD)"",
                ""1600 x 900 (HD+)"",
                ""1920 x 1080 (FHD)"",
                ""2560 x 1440 (QHD)"",
                ""3840 x 2160 (4K UHD)""
            };
            try
            {
                Rectangle bounds = Screen.PrimaryScreen.Bounds;
                string nativeKey = bounds.Width + "" x "" + bounds.Height;
                if (!resItems.Any(r => r.StartsWith(nativeKey)))
                {
                    resItems.Add(nativeKey + "" (현재 모니터 기본)"");
                }
            }
            catch { }
            cboResolution.Items.AddRange(resItems.ToArray());
            SelectResolutionByText(""__DEFAULT_RES__"");
            this.Controls.Add(cboResolution);
            y += 38;

            // 4. 화면(창) 모드
            AddRowLabel(""화면 표시 모드:"", y);
            cboWindowMode = CreateCombo(new Point(158, y), 300);
            cboWindowMode.Items.AddRange(new object[]
            {
                ""테두리 없는 전체 창 (Windowed Fullscreen)"",
                ""전체 화면 (Exclusive Fullscreen)"",
                ""창 모드 (Windowed)""
            });
            cboWindowMode.SelectedIndex = __DEFAULT_WINMODE_IDX__;
            this.Controls.Add(cboWindowMode);
            y += 38;

            // 5. 최대 프레임 제한
            AddRowLabel(""최대 프레임 제한:"", y);
            cboFpsLimit = CreateCombo(new Point(158, y), 300);
            cboFpsLimit.Items.AddRange(new object[]
            {
                ""무제한 (Unlimited)"",
                ""30 FPS"",
                ""60 FPS"",
                ""120 FPS"",
                ""144 FPS""
            });
            SelectFpsByValue(__DEFAULT_FPS__);
            this.Controls.Add(cboFpsLimit);
            y += 36;

            // 6. 수직동기화
            chkVSync = new CheckBox
            {
                Text = ""수직동기화 (VSync 켜기 — 화면 찢어짐 방지)"",
                Location = new Point(158, y),
                AutoSize = true,
                Checked = __DEFAULT_VSYNC__,
                ForeColor = FgText
            };
            this.Controls.Add(chkVSync);
            y += 38;

            // 하단 실행 버튼 영역
            Button btnLaunch = new Button
            {
                Text = ""▶ 선택한 옵션으로 게임 시작"",
                Location = new Point(18, y),
                Size = new Size(276, 46),
                BackColor = AccentGreen,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font(""Malgun Gothic"", 11f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnLaunch.FlatAppearance.BorderSize = 0;
            btnLaunch.Click += (s, e) => ApplyAndLaunch(true);

            Button btnSaveOnly = new Button
            {
                Text = ""설정만 저장"",
                Location = new Point(302, y),
                Size = new Size(88, 46),
                BackColor = AccentBlue,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font(""Malgun Gothic"", 9f, FontStyle.Bold),
                Cursor = Cursors.Hand
            };
            btnSaveOnly.FlatAppearance.BorderSize = 0;
            btnSaveOnly.Click += (s, e) => ApplyAndLaunch(false);

            Button btnClose = new Button
            {
                Text = ""닫기"",
                Location = new Point(396, y),
                Size = new Size(64, 46),
                BackColor = BgCard,
                ForeColor = FgSub,
                FlatStyle = FlatStyle.Flat,
                Cursor = Cursors.Hand
            };
            btnClose.FlatAppearance.BorderColor = Color.FromArgb(70, 78, 92);
            btnClose.Click += (s, e) => this.Close();

            this.Controls.Add(btnLaunch);
            this.Controls.Add(btnSaveOnly);
            this.Controls.Add(btnClose);
        }

        private void AddRowLabel(string text, int y)
        {
            Label lbl = new Label
            {
                Text = text,
                Location = new Point(18, y + 4),
                AutoSize = true,
                ForeColor = FgSub,
                Font = new Font(""Malgun Gothic"", 9.2f, FontStyle.Bold)
            };
            this.Controls.Add(lbl);
        }

        private ComboBox CreateCombo(Point loc, int width)
        {
            return new ComboBox
            {
                Location = loc,
                Width = width,
                BackColor = BgInput,
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                DropDownStyle = ComboBoxStyle.DropDownList
            };
        }

        private void UpdatePresetDesc()
        {
            int idx = cboPreset.SelectedIndex;
            if (idx >= 0 && idx < PresetDescriptions.Length && lblPresetDesc != null)
                lblPresetDesc.Text = PresetDescriptions[idx];
        }

        private void SelectResolutionByText(string res)
        {
            var m = Regex.Match(res ?? """", @""(\d{3,5})\s*[xX]\s*(\d{3,5})"");
            if (m.Success)
            {
                string prefix = m.Groups[1].Value + "" x "" + m.Groups[2].Value;
                for (int i = 0; i < cboResolution.Items.Count; i++)
                {
                    if (cboResolution.Items[i].ToString().StartsWith(prefix))
                    {
                        cboResolution.SelectedIndex = i;
                        return;
                    }
                }
            }
            if (cboResolution.Items.Count > 2) cboResolution.SelectedIndex = 2;
        }

        private void SelectFpsByValue(int fps)
        {
            if (fps == 30) cboFpsLimit.SelectedIndex = 1;
            else if (fps == 60) cboFpsLimit.SelectedIndex = 2;
            else if (fps == 120) cboFpsLimit.SelectedIndex = 3;
            else if (fps == 144) cboFpsLimit.SelectedIndex = 4;
            else cboFpsLimit.SelectedIndex = 0;
        }

        private string GetPrefsFilePath()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ""launcher_prefs.cfg"");
        }

        private void LoadLastPrefs()
        {
            try
            {
                string p = GetPrefsFilePath();
                if (!File.Exists(p)) return;
                foreach (var line in File.ReadAllLines(p, Encoding.UTF8))
                {
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim();
                    string v = line.Substring(eq + 1).Trim();
                    int iv;
                    if (k == ""Preset"" && int.TryParse(v, out iv) && iv >= 0 && iv < cboPreset.Items.Count)
                        cboPreset.SelectedIndex = iv;
                    else if (k == ""ResScale"" && int.TryParse(v, out iv) && iv >= 0 && iv < cboResScale.Items.Count)
                        cboResScale.SelectedIndex = iv;
                    else if (k == ""Resolution"")
                        SelectResolutionByText(v);
                    else if (k == ""WinMode"" && int.TryParse(v, out iv) && iv >= 0 && iv < cboWindowMode.Items.Count)
                        cboWindowMode.SelectedIndex = iv;
                    else if (k == ""FpsIdx"" && int.TryParse(v, out iv) && iv >= 0 && iv < cboFpsLimit.Items.Count)
                        cboFpsLimit.SelectedIndex = iv;
                    else if (k == ""VSync"")
                        chkVSync.Checked = v.Equals(""true"", StringComparison.OrdinalIgnoreCase);
                }
            }
            catch { }
        }

        private void SaveLastPrefs(string resKey)
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine(""Preset="" + cboPreset.SelectedIndex);
                sb.AppendLine(""ResScale="" + cboResScale.SelectedIndex);
                sb.AppendLine(""Resolution="" + resKey);
                sb.AppendLine(""WinMode="" + cboWindowMode.SelectedIndex);
                sb.AppendLine(""FpsIdx="" + cboFpsLimit.SelectedIndex);
                sb.AppendLine(""VSync="" + (chkVSync.Checked ? ""true"" : ""false""));
                File.WriteAllText(GetPrefsFilePath(), sb.ToString(), new UTF8Encoding(false));
            }
            catch { }
        }

        private void ApplyAndLaunch(bool launchGame)
        {
            int q = cboPreset.SelectedIndex >= 0 ? cboPreset.SelectedIndex : 3;
            int resScale = 100;
            if (cboResScale.SelectedIndex == 1) resScale = 85;
            else if (cboResScale.SelectedIndex == 2) resScale = 75;
            else if (cboResScale.SelectedIndex == 3) resScale = 50;

            int w = 1920, h = 1080;
            var m = Regex.Match(cboResolution.Text ?? """", @""(\d{3,5})\s*x\s*(\d{3,5})"");
            if (m.Success)
            {
                int.TryParse(m.Groups[1].Value, out w);
                int.TryParse(m.Groups[2].Value, out h);
            }

            // UI: 0=WindowedFullscreen(UE:1), 1=Fullscreen(UE:0), 2=Windowed(UE:2)
            int ueFullscreenMode = 1;
            if (cboWindowMode.SelectedIndex == 1) ueFullscreenMode = 0;
            else if (cboWindowMode.SelectedIndex == 2) ueFullscreenMode = 2;

            int fps = 0;
            if (cboFpsLimit.SelectedIndex == 1) fps = 30;
            else if (cboFpsLimit.SelectedIndex == 2) fps = 60;
            else if (cboFpsLimit.SelectedIndex == 3) fps = 120;
            else if (cboFpsLimit.SelectedIndex == 4) fps = 144;

            bool vsync = chkVSync.Checked;
            SaveLastPrefs(w + ""x"" + h);

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            string[] targetInis = new string[]
            {
                Path.Combine(baseDir, ProjectName, @""Saved\Config\Windows\GameUserSettings.ini""),
                Path.Combine(localAppData, ProjectName, @""Saved\Config\Windows\GameUserSettings.ini"")
            };

            foreach (var iniPath in targetInis)
            {
                try { WriteUe5Ini(iniPath, q, resScale, w, h, ueFullscreenMode, fps, vsync); }
                catch { }
            }

            if (!launchGame)
            {
                MessageBox.Show(
                    ""선택한 그래픽 프리셋 및 디스플레이 설정이 저장되었습니다!\n이제 "" + ProjectName + "".exe 를 직접 실행하셔도 이 옵션으로 시작됩니다."",
                    ""설정 저장 완료"", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            string gameExe = FindGameExecutable(baseDir);
            if (string.IsNullOrEmpty(gameExe) || !File.Exists(gameExe))
            {
                MessageBox.Show(
                    ""실행할 게임 파일("" + ProjectName + "".exe)을 같은 폴더에서 찾을 수 없습니다.\n현재 폴더: "" + baseDir,
                    ""실행 파일 없음"", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            List<string> args = new List<string>();
            args.Add(""-ResX="" + w);
            args.Add(""-ResY="" + h);
            if (ueFullscreenMode == 0) args.Add(""-FULLSCREEN"");
            else if (ueFullscreenMode == 2) args.Add(""-WINDOWED"");
            args.Add(vsync ? ""-VSync"" : ""-NoVSync"");

            try
            {
                Process.Start(new ProcessStartInfo(gameExe, string.Join("" "", args.ToArray()))
                {
                    WorkingDirectory = Path.GetDirectoryName(gameExe),
                    UseShellExecute = true
                });
                this.Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(""게임 실행 실패: "" + ex.Message, ""오류"", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private string FindGameExecutable(string baseDir)
        {
            string exact = Path.Combine(baseDir, ProjectName + "".exe"");
            if (File.Exists(exact)) return exact;

            string selfPath = Application.ExecutablePath;
            var candidates = Directory.GetFiles(baseDir, ""*.exe"", SearchOption.TopDirectoryOnly)
                .Where(f => !string.Equals(f, selfPath, StringComparison.OrdinalIgnoreCase) &&
                            !Path.GetFileName(f).StartsWith(""UEPrereqSetup"", StringComparison.OrdinalIgnoreCase) &&
                            !Path.GetFileName(f).StartsWith(""CrashReportClient"", StringComparison.OrdinalIgnoreCase))
                .ToArray();
            return candidates.Length > 0 ? candidates[0] : null;
        }

        private void WriteUe5Ini(string iniPath, int q, int resScale, int w, int h, int fsMode, int fps, bool vsync)
        {
            StringBuilder preserved = new StringBuilder();
            if (File.Exists(iniPath))
            {
                string[] lines = File.ReadAllText(iniPath, Encoding.UTF8).Split(new[] { ""\r\n"", ""\n"" }, StringSplitOptions.None);
                bool skip = false;
                foreach (var raw in lines)
                {
                    string t = raw.Trim();
                    if (t.StartsWith(""["") && t.EndsWith(""]""))
                    {
                        skip = t.Equals(""[ScalabilityGroups]"", StringComparison.OrdinalIgnoreCase) ||
                               t.Equals(""[/Script/Engine.GameUserSettings]"", StringComparison.OrdinalIgnoreCase);
                    }
                    if (!skip && t.Length > 0) preserved.AppendLine(raw);
                }
            }

            StringBuilder sb = new StringBuilder();
            if (preserved.Length > 0)
            {
                sb.Append(preserved.ToString().TrimEnd());
                sb.AppendLine();
                sb.AppendLine();
            }

            sb.AppendLine(""[ScalabilityGroups]"");
            sb.AppendFormat(""sg.ResolutionQuality={0}\r\n"", resScale);
            sb.AppendFormat(""sg.ViewDistanceQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.AntiAliasingQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.ShadowQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.GlobalIlluminationQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.ReflectionsQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.PostProcessQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.TextureQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.EffectsQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.FoliageQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.ShadingQuality={0}\r\n"", q);
            sb.AppendFormat(""sg.LandscapeQuality={0}\r\n"", q);
            sb.AppendLine();
            sb.AppendLine(""[/Script/Engine.GameUserSettings]"");
            sb.AppendFormat(""bUseVSync={0}\r\n"", vsync ? ""True"" : ""False"");
            sb.AppendLine(""bUseDynamicResolution=False"");
            sb.AppendFormat(""ResolutionSizeX={0}\r\n"", w);
            sb.AppendFormat(""ResolutionSizeY={0}\r\n"", h);
            sb.AppendFormat(""LastUserConfirmedResolutionSizeX={0}\r\n"", w);
            sb.AppendFormat(""LastUserConfirmedResolutionSizeY={0}\r\n"", h);
            sb.AppendLine(""WindowPosX=-1"");
            sb.AppendLine(""WindowPosY=-1"");
            sb.AppendFormat(""FullscreenMode={0}\r\n"", fsMode);
            sb.AppendFormat(""LastConfirmedFullscreenMode={0}\r\n"", fsMode);
            sb.AppendFormat(""PreferredFullscreenMode={0}\r\n"", fsMode);
            sb.AppendLine(""Version=5"");
            sb.AppendLine(""AudioQualityLevel=0"");
            sb.AppendLine(""LastConfirmedAudioQualityLevel=0"");
            sb.AppendFormat(""FrameRateLimit={0}.000000\r\n"", fps <= 0 ? 0 : fps);
            sb.AppendFormat(""DesiredScreenWidth={0}\r\n"", w);
            sb.AppendFormat(""DesiredScreenHeight={0}\r\n"", h);
            sb.AppendLine(""bUseDesiredScreenHeight=True"");
            sb.AppendFormat(""LastUserConfirmedDesiredScreenWidth={0}\r\n"", w);
            sb.AppendFormat(""LastUserConfirmedDesiredScreenHeight={0}\r\n"", h);

            string parent = Path.GetDirectoryName(iniPath);
            if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent))
                Directory.CreateDirectory(parent);
            File.WriteAllText(iniPath, sb.ToString(), new UTF8Encoding(false));
        }
    }

    static class LauncherProgram
    {
        [DllImport(""user32.dll"")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main()
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new LauncherForm());
        }
    }
}";
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            if (args != null && args.Length >= 2 && args[0] == "--make-launcher")
            {
                string pkgDir = args[1];
                string projName = args.Length >= 3 ? args[2] : "";
                string preset = args.Length >= 4 ? args[3] : "Epic";
                string res = args.Length >= 5 ? args[4] : "1920x1080";
                string winMode = args.Length >= 6 ? args[5] : "WindowedFullscreen";
                string outPath, err;
                bool ok = GameLauncherBuilder.GenerateLauncherInPackage(pkgDir, projName, preset, res, winMode, 0, true, out outPath, out err);
                Environment.Exit(ok ? 0 : 1);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
