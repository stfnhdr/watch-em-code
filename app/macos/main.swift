// Watch Him Code – lean Mac app.
// Starts server.js invisibly in the background, shows the UI in its own
// window (WKWebView) and stops the server again when closed.

import Cocoa
import WebKit

let defaultPort = 4777
let darkBar = NSColor(srgbRed: 0x16 / 255.0, green: 0x16 / 255.0, blue: 0x19 / 255.0, alpha: 1)
let lightBar = NSColor(srgbRed: 0xE2 / 255.0, green: 0xE2 / 255.0, blue: 0xE7 / 255.0, alpha: 1)

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        DispatchQueue.global(qos: .userInitiated).async { self.start() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    // MARK: Window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "whc")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Watch Him Code"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 720, height: 460)
        window.contentView = webView
        applyTheme(NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? "dark" : "light")
        window.center()
        window.setFrameAutosaveName("WatchHimCodeMain") // remember size and position
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /** Match title bar and background to the page's theme. */
    func applyTheme(_ theme: String) {
        let dark = theme == "dark"
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.backgroundColor = dark ? darkBar : lightBar
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? [String: Any], let theme = body["theme"] as? String {
            applyTheme(theme)
        }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Watch Him Code", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Watch Him Code", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Watch Him Code", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = view

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = win
        NSApp.windowsMenu = win

        NSApp.mainMenu = main
    }

    @objc func reload() { webView.reload() }

    // MARK: Server

    func start() {
        // Is a server already running (e.g. via `node server.js`)? Then just show it.
        if isOurs(port: defaultPort) {
            show(URL(string: "http://127.0.0.1:\(defaultPort)")!)
            return
        }
        guard let node = findNode() else {
            fail("Node.js was not found.",
                 "Watch Him Code needs Node.js 18 or newer. Install it from nodejs.org and restart the app.")
            return
        }
        guard let dir = Bundle.main.resourceURL?.appendingPathComponent("server") else { return }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [dir.appendingPathComponent("server.js").path]
        p.currentDirectoryURL = dir
        var env = ProcessInfo.processInfo.environment
        env["WHC_NO_OPEN"] = "1"
        env["WHC_PARENT_PID"] = String(getpid()) // server exits if the app crashes
        p.environment = env

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        var shown = false
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            if !shown, let r = text.range(of: #"http://127\.0\.0\.1:\d+"#, options: .regularExpression) {
                shown = true
                self.show(URL(string: String(text[r]))!)
            }
        }
        p.terminationHandler = { _ in
            if !shown { self.fail("The server could not start.", "Please try `node server.js` in the Terminal.") }
        }
        do {
            try p.run()
            server = p
        } catch {
            fail("The server could not start.", error.localizedDescription)
        }
    }

    func show(_ base: URL) {
        DispatchQueue.main.async {
            self.webView.load(URLRequest(url: base))
        }
    }

    func fail(_ title: String, _ detail: String) {
        DispatchQueue.main.async {
            let html = """
            <body style="margin:0;height:100vh;display:grid;place-content:center;text-align:center;
              font:15px -apple-system;background:#1f1f23;color:#dcdce0">
              <h2 style="font-weight:600">\(title)</h2><p style="color:#8e8e96">\(detail)</p></body>
            """
            self.webView.loadHTMLString(html, baseURL: nil)
        }
    }

    /** Is Watch Him Code already answering on this port? */
    func isOurs(port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/whc") else { return false }
        var ok = false
        let done = DispatchSemaphore(value: 0)
        var req = URLRequest(url: url)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data = data, let s = String(data: data, encoding: .utf8), s.contains("watch-him-code") { ok = true }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 1.5)
        return ok
    }

    /** Find Node: first like the Terminal does (login shell), then common locations. */
    func findNode() -> String? {
        let fm = FileManager.default
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-ilc", "command -v node"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        if (try? p.run()) != nil {
            p.waitUntilExit()
            let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            if let line = text.split(separator: "\n").map(String.init).last(where: { $0.hasPrefix("/") }),
               fm.isExecutableFile(atPath: line) {
                return line
            }
        }
        let home = fm.homeDirectoryForCurrentUser.path
        var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.volta/bin/node", "\(home)/.local/bin/node"]
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvm) {
            candidates += versions.sorted().reversed().map { "\(nvm)/\($0)/bin/node" }
        }
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
