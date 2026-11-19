// Watch Him Code – lean Windows app.
// Starts server.js invisibly in the background and shows the UI in its own
// window (WebView2). Closing the window keeps it running in the notification
// area (tray); "Quit" there really ends it and stops the server.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WatchHimCode
{
    static class Program
    {
        const string MutexName = "WatchHimCode.SingleInstance";
        internal const string ShowEventName = "WatchHimCode.ShowWindow";

        [STAThread]
        static void Main()
        {
            // Only one instance: starting the app again just brings the window back.
            using (var mutex = new Mutex(true, MutexName, out bool first))
            {
                if (!first)
                {
                    try { EventWaitHandle.OpenExisting(ShowEventName).Set(); } catch { }
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }
    }

    sealed class MainForm : Form
    {
        const int DefaultPort = 4777;
        static readonly string DataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WatchHimCode");

        readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
        Process server;
        bool shown;
        string pageUrl;                    // the page we show (once the server is up)
        bool pageReady;                    // the page reported it is up and connected
        readonly System.Windows.Forms.Timer watchdog = new System.Windows.Forms.Timer { Interval = 8000 };
        readonly NotifyIcon tray = new NotifyIcon();
        readonly EventWaitHandle showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
        bool quitting;
        bool hintShown;

        public MainForm()
        {
            Text = "Watch Him Code";
            ClientSize = new Size(1400, 900);
            MinimumSize = new Size(720, 460);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(0x1f, 0x1f, 0x23);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            RestoreWindow();
            BuildTray();

            Load += async (s, e) => await InitAsync();
            FormClosing += (s, e) =>
            {
                SaveWindow();
                // Closing the window (X, Alt+F4) only hides it; the server keeps collecting changes.
                if (e.CloseReason == CloseReason.UserClosing && !quitting)
                {
                    e.Cancel = true;
                    Hide();
                    if (!hintShown)
                    {
                        hintShown = true;
                        tray.ShowBalloonTip(4000, "Watch Him Code keeps running",
                            "It keeps watching in the background. Click the icon to open it, right-click → Quit to end it.",
                            ToolTipIcon.Info);
                    }
                    return;
                }
                tray.Visible = false;
                try { if (server != null && !server.HasExited) server.Kill(); } catch { }
            };

            // Another start of the app asks us to show the window.
            ThreadPool.RegisterWaitForSingleObject(showSignal,
                (state, timedOut) => BeginInvoke(new Action(ShowFromTray)), null, Timeout.Infinite, false);
        }

        // ---------------------------------------------------------------
        // Notification area (tray)

        void BuildTray()
        {
            tray.Icon = Icon ?? SystemIcons.Application;
            tray.Text = "Watch Him Code";
            var menu = new ContextMenuStrip();
            var open = menu.Items.Add("Show Watch Him Code", null, (s, e) => ShowFromTray());
            open.Font = new Font(open.Font, FontStyle.Bold);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit", null, (s, e) => Quit());
            tray.ContextMenuStrip = menu;
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowFromTray(); };
            tray.BalloonTipClicked += (s, e) => ShowFromTray();
            tray.Visible = true;
        }

        void ShowFromTray()
        {
            Show();
            if (pageUrl != null && !pageReady) LoadPage();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        void Quit()
        {
            quitting = true;
            Close();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                tray.Dispose();
                showSignal.Dispose();
            }
            base.Dispose(disposing);
        }

        // ---------------------------------------------------------------
        // WebView2

        async Task InitAsync()
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir, "WebView2"));
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception)
            {
                var answer = MessageBox.Show(this,
                    "Watch Him Code needs the \"Microsoft Edge WebView2 Runtime\".\n\nOpen the download page now?",
                    "Watch Him Code", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (answer == DialogResult.Yes)
                    Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
                Quit();
                return;
            }

            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            // The page runs in a separate process. If it dies or hangs, the window
            // would stay blank – load the page again instead.
            web.CoreWebView2.NavigationCompleted += (s, e) =>
            {
                if (!e.IsSuccess && !pageReady && pageUrl != null)
                {
                    var retry = new System.Windows.Forms.Timer { Interval = 1000 };
                    retry.Tick += (s2, e2) => { retry.Stop(); retry.Dispose(); if (!pageReady) LoadPage(); };
                    retry.Start();
                }
            };
            watchdog.Tick += (s, e) => { watchdog.Stop(); if (!pageReady) LoadPage(); };
            web.CoreWebView2.ProcessFailed += (s, e) =>
            {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                    e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive ||
                    e.ProcessFailedKind == CoreWebView2ProcessFailedKind.FrameRenderProcessExited)
                    BeginInvoke(new Action(() => { try { LoadPage(); } catch { } }));
            };
            web.CoreWebView2.WebMessageReceived += (s, e) =>
            {
                string json = e.WebMessageAsJson ?? "";
                // The page reports its theme: adjust the title bar
                if (json.Contains("\"theme\"")) SetDarkTitleBar(json.Contains("\"dark\""));
                // Links (e.g. "What's new") open in the default browser
                var open = Regex.Match(json, "\"open\"\\s*:\\s*\"(https://[^\"]+)\"");
                if (open.Success)
                    try { Process.Start(new ProcessStartInfo(open.Groups[1].Value) { UseShellExecute = true }); } catch { }
                // The page is up and connected
                if (json.Contains("\"ready\"")) { pageReady = true; watchdog.Stop(); }
                // Double-click on the page's title bar: maximize / restore
                if (json.Contains("\"titlebar\""))
                    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                // "Install & restart" clicked
                var update = Regex.Match(json, "\"update\"\\s*:\\s*\\{[^}]*\"url\"\\s*:\\s*\"(https://[^\"]+)\"");
                if (update.Success) _ = InstallUpdateAsync(update.Groups[1].Value);
            };
            await Task.Run(() => Start());
        }

        void Navigate(string url)
        {
            if (shown) return;
            shown = true;
            pageUrl = url;
            BeginInvoke(new Action(LoadPage));
        }

        /// Load the page and make sure it comes up: the page reports "ready" once
        /// connected. If not within a few seconds, load it again – no blank window.
        void LoadPage()
        {
            if (pageUrl == null || web.CoreWebView2 == null) return;
            pageReady = false;
            web.CoreWebView2.Navigate(pageUrl);
            watchdog.Stop();
            watchdog.Start();
        }

        void Fail(string title, string detail)
        {
            BeginInvoke(new Action(() => web.CoreWebView2.NavigateToString(
                "<body style=\"margin:0;height:100vh;display:grid;place-content:center;text-align:center;" +
                "font:15px 'Segoe UI',sans-serif;background:#1f1f23;color:#dcdce0\">" +
                $"<h2 style=\"font-weight:600\">{title}</h2><p style=\"color:#8e8e96\">{detail}</p></body>")));
        }

        // ---------------------------------------------------------------
        // Update (only when the user clicks "Install & restart")

        const string ReleaseDownloads = "https://github.com/stfnhdr/watch-him-code/releases/download/";

        void ReportUpdate(string state, string message = "")
        {
            string json = "{\"state\":\"" + state + "\",\"message\":\"" + JsonEscape(message) + "\"}";
            BeginInvoke(new Action(() =>
                web.CoreWebView2?.ExecuteScriptAsync($"window.whcUpdateState && window.whcUpdateState({json})")));
        }

        static string JsonEscape(string s) =>
            (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");

        async Task InstallUpdateAsync(string link)
        {
            // Only official release downloads from this repository.
            if (!link.StartsWith(ReleaseDownloads, StringComparison.Ordinal))
            {
                ReportUpdate("error", "Unexpected download address.");
                return;
            }
            string appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            try
            {
                string probe = Path.Combine(appDir, ".whc-write-test");
                File.WriteAllText(probe, "");
                File.Delete(probe);
            }
            catch
            {
                ReportUpdate("error", $"No permission to replace the app in {appDir}. Download the new version from the release page instead.");
                return;
            }

            ReportUpdate("downloading");
            string work = Path.Combine(Path.GetTempPath(), "whc-update-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(work);
                string zip = Path.Combine(work, "update.zip");
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                using (var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) })
                {
                    http.DefaultRequestHeaders.UserAgent.ParseAdd("watch-him-code");
                    File.WriteAllBytes(zip, await http.GetByteArrayAsync(link));
                }
                string unpacked = Path.Combine(work, "unpacked");
                ZipFile.ExtractToDirectory(zip, unpacked);
                string exe = Directory.GetFiles(unpacked, "WatchHimCode.exe", SearchOption.AllDirectories).FirstOrDefault();
                if (exe == null) throw new Exception("The download does not contain Watch Him Code.");
                string newDir = Path.GetDirectoryName(exe);

                ReportUpdate("installing");
                // A running .exe can't be replaced: a small script waits until we
                // have quit, copies the new files over and starts the new version.
                int pid = Process.GetCurrentProcess().Id;
                string script = Path.Combine(Path.GetTempPath(), "whc-update-" + pid + ".cmd");
                File.WriteAllText(script, string.Join("\r\n", new[]
                {
                    "@echo off",
                    ":wait",
                    $"tasklist /FI \"PID eq {pid}\" 2>nul | find \"{pid}\" >nul && (timeout /t 1 /nobreak >nul & goto wait)",
                    $"robocopy \"{newDir}\" \"{appDir}\" /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul",
                    $"start \"\" \"{Path.Combine(appDir, "WatchHimCode.exe")}\"",
                    $"rmdir /s /q \"{work}\"",
                    "(goto) 2>nul & del \"%~f0\"",
                }) + "\r\n");
                Process.Start(new ProcessStartInfo("cmd.exe", $"/c \"\"{script}\"\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                });
                BeginInvoke(new Action(Quit));
            }
            catch (Exception ex)
            {
                ReportUpdate("error", "Update failed: " + ex.Message);
                try { Directory.Delete(work, true); } catch { }
            }
        }

        // ---------------------------------------------------------------
        // Server

        void Start()
        {
            // Is a server already running (e.g. via `node server.js`)? Then just show it.
            if (IsOurs(DefaultPort))
            {
                Navigate($"http://127.0.0.1:{DefaultPort}");
                return;
            }
            string node = FindNode();
            if (node == null)
            {
                Fail("Node.js was not found.",
                     "Watch Him Code needs Node.js 18 or newer. Install it from nodejs.org and restart the app.");
                return;
            }
            string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "server");
            var psi = new ProcessStartInfo(node, "\"" + Path.Combine(dir, "server.js") + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = dir,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            psi.EnvironmentVariables["WHC_NO_OPEN"] = "1";
            // Server exits if the app crashes
            psi.EnvironmentVariables["WHC_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();
            var v = typeof(MainForm).Assembly.GetName().Version;
            psi.EnvironmentVariables["WHC_APP_VERSION"] = $"{v.Major}.{v.Minor}.{v.Build}";

            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            DataReceivedEventHandler onLine = (s, e) =>
            {
                if (e.Data == null) return;
                var m = Regex.Match(e.Data, @"http://127\.0\.0\.1:\d+");
                if (m.Success) Navigate(m.Value);
            };
            p.OutputDataReceived += onLine;
            p.ErrorDataReceived += onLine;
            p.Exited += (s, e) =>
            {
                if (!shown) Fail("The server could not start.", "Please try <code>node server.js</code> in a command prompt.");
            };
            try
            {
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                server = p;
            }
            catch (Exception ex)
            {
                Fail("The server could not start.", ex.Message);
            }
        }

        static bool IsOurs(int port)
        {
            try
            {
                using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(1) })
                {
                    string body = http.GetStringAsync($"http://127.0.0.1:{port}/whc").Result;
                    return body.Contains("watch-him-code");
                }
            }
            catch { return false; }
        }

        /** Find Node: first via PATH (`where node`), then common locations. */
        static string FindNode()
        {
            try
            {
                var psi = new ProcessStartInfo("where.exe", "node")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                };
                using (var p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    string hit = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                        .FirstOrDefault(l => l.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(l));
                    if (hit != null) return hit;
                }
            }
            catch { }

            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            var candidates = new[]
            {
                Path.Combine(pf, "nodejs", "node.exe"),
                Path.Combine(local, "Programs", "nodejs", "node.exe"),
                Path.Combine(local, "Volta", "bin", "node.exe"),
                Path.Combine(roaming, "nvm", "nodejs", "node.exe"),
                @"C:\Program Files\nodejs\node.exe",
            };
            return candidates.FirstOrDefault(File.Exists);
        }

        // ---------------------------------------------------------------
        // Window: dark title bar, remember size and position

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        void SetDarkTitleBar(bool dark)
        {
            BeginInvoke(new Action(() =>
            {
                int on = dark ? 1 : 0;
                // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 20H1+ / Windows 11), 19 on older builds
                if (DwmSetWindowAttribute(Handle, 20, ref on, sizeof(int)) != 0)
                    DwmSetWindowAttribute(Handle, 19, ref on, sizeof(int));
                BackColor = dark ? Color.FromArgb(0x1f, 0x1f, 0x23) : Color.White;
            }));
        }

        string WindowFile => Path.Combine(DataDir, "window.txt");

        void SaveWindow()
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(WindowFile, $"{b.X},{b.Y},{b.Width},{b.Height},{(WindowState == FormWindowState.Maximized ? 1 : 0)}");
            }
            catch { }
        }

        void RestoreWindow()
        {
            try
            {
                var v = File.ReadAllText(WindowFile).Split(',').Select(int.Parse).ToArray();
                var r = new Rectangle(v[0], v[1], v[2], v[3]);
                if (Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(r)))
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = r;
                    if (v[4] == 1) WindowState = FormWindowState.Maximized;
                }
            }
            catch { }
        }
    }
}
