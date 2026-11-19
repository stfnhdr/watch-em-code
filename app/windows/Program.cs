// Watch Him Code – schlanke Windows-App.
// Startet server.js unsichtbar im Hintergrund, zeigt die Oberfläche in einem
// eigenen Fenster (WebView2) und beendet den Server beim Schließen wieder.

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WatchHimCode
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
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

            Load += async (s, e) => await InitAsync();
            FormClosing += (s, e) =>
            {
                SaveWindow();
                try { if (server != null && !server.HasExited) server.Kill(); } catch { }
            };
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
                    "Für Watch Him Code wird die „Microsoft Edge WebView2 Runtime“ benötigt.\n\nJetzt die Download-Seite öffnen?",
                    "Watch Him Code", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (answer == DialogResult.Yes)
                    Process.Start(new ProcessStartInfo("https://developer.microsoft.com/microsoft-edge/webview2/") { UseShellExecute = true });
                Close();
                return;
            }

            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.WebMessageReceived += (s, e) =>
            {
                // Die Seite meldet ihren Farbmodus: Titelleiste anpassen
                string json = e.WebMessageAsJson ?? "";
                if (json.Contains("\"theme\"")) SetDarkTitleBar(json.Contains("\"dark\""));
            };
            await Task.Run(() => Start());
        }

        void Navigate(string url)
        {
            if (shown) return;
            shown = true;
            BeginInvoke(new Action(() => web.CoreWebView2.Navigate(url)));
        }

        void Fail(string title, string detail)
        {
            BeginInvoke(new Action(() => web.CoreWebView2.NavigateToString(
                "<body style=\"margin:0;height:100vh;display:grid;place-content:center;text-align:center;" +
                "font:15px 'Segoe UI',sans-serif;background:#1f1f23;color:#dcdce0\">" +
                $"<h2 style=\"font-weight:600\">{title}</h2><p style=\"color:#8e8e96\">{detail}</p></body>")));
        }

        // ---------------------------------------------------------------
        // Server

        void Start()
        {
            // Läuft schon ein Server (z. B. per `node server.js`)? Dann nur anzeigen.
            if (IsOurs(DefaultPort))
            {
                Navigate($"http://127.0.0.1:{DefaultPort}");
                return;
            }
            string node = FindNode();
            if (node == null)
            {
                Fail("Node.js wurde nicht gefunden.",
                     "Watch Him Code braucht Node.js 18 oder neuer. Installieren von nodejs.org und die App neu starten.");
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
            // Server beendet sich, falls die App abstürzt
            psi.EnvironmentVariables["WHC_PARENT_PID"] = Process.GetCurrentProcess().Id.ToString();

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
                if (!shown) Fail("Der Server konnte nicht starten.", "Bitte in der Eingabeaufforderung <code>node server.js</code> ausprobieren.");
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
                Fail("Der Server konnte nicht starten.", ex.Message);
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

        /** Node suchen: zuerst über PATH (`where node`), dann übliche Orte. */
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
        // Fenster: dunkle Titelleiste, Größe und Position merken

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        void SetDarkTitleBar(bool dark)
        {
            BeginInvoke(new Action(() =>
            {
                int on = dark ? 1 : 0;
                // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 20H1+ / Windows 11), 19 für ältere Builds
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
