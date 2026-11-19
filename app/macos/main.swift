// Watch Him Code – lean Mac app.
// Starts server.js invisibly in the background, shows the UI in its own
// window (WKWebView) and stops the server again when closed.

import Cocoa
import WebKit

let defaultPort = 4777
let darkBar = NSColor(srgbRed: 0x16 / 255.0, green: 0x16 / 255.0, blue: 0x19 / 255.0, alpha: 1)
let lightBar = NSColor(srgbRed: 0xE2 / 255.0, green: 0xE2 / 255.0, blue: 0xE7 / 255.0, alpha: 1)

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        if offerMoveToApplications() { return } // moving and restarting
        DispatchQueue.global(qos: .userInitiated).async { self.start() }
    }

    // MARK: Running from Downloads or a disk image?

    /// macOS runs apps that were started straight out of Downloads from a hidden,
    /// read-only copy ("App Translocation"). That copy can vanish while the app runs
    /// (crash) and can't be updated. Same for an app started inside the DMG.
    /// Offer to move it to Applications and restart from there.
    func offerMoveToApplications() -> Bool {
        let current = Bundle.main.bundleURL
        let translocated = current.path.contains("/AppTranslocation/")
        let readOnly = (try? current.resourceValues(forKeys: [.volumeIsReadOnlyKey]))?.volumeIsReadOnly ?? false
        guard translocated || readOnly else { return false }

        let alert = NSAlert()
        alert.messageText = "Move Watch Him Code to Applications?"
        alert.informativeText = translocated
            ? "It's running straight from your Downloads, so macOS uses a temporary copy. That copy can disappear while the app runs, and updates can't be installed.\n\nMove it to Applications and restart from there?"
            : "It's running from the disk image. Updates can't be installed there.\n\nCopy it to Applications and restart from there?"
        alert.addButton(withTitle: "Move to Applications")
        alert.addButton(withTitle: "Not Now")
        alert.alertStyle = .informational
        guard alert.runModal() == .alertFirstButtonReturn else { return false }

        // Where the user's real copy is (for a translocated app macOS knows the original).
        let source = translocated ? (originalURL(of: current) ?? current) : current
        do {
            let target = try installIntoApplications(source, move: translocated && source != current)
            relaunch(target)
            return true
        } catch {
            let fail = NSAlert()
            fail.messageText = "Couldn't move the app"
            fail.informativeText = "\(error.localizedDescription)\n\nPlease drag Watch Him Code into your Applications folder yourself and open it from there."
            fail.runModal()
            return false
        }
    }

    /// Original location of a translocated app (Security framework, looked up at runtime).
    func originalURL(of url: URL) -> URL? {
        typealias Fn = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        guard let lib = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
              let sym = dlsym(lib, "SecTranslocateCreateOriginalPathForURL") else { return nil }
        let fn = unsafeBitCast(sym, to: Fn.self)
        guard let result = fn(url as CFURL, nil)?.takeRetainedValue() as URL?,
              FileManager.default.fileExists(atPath: result.path) else { return nil }
        return result
    }

    func installIntoApplications(_ source: URL, move: Bool) throws -> URL {
        let fm = FileManager.default
        var folder = URL(fileURLWithPath: "/Applications")
        if let custom = ProcessInfo.processInfo.environment["WHC_INSTALL_DIR"] { folder = URL(fileURLWithPath: custom) } // for testing
        if !fm.isWritableFile(atPath: folder.path) {
            folder = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        let target = folder.appendingPathComponent(source.lastPathComponent)
        if fm.fileExists(atPath: target.path) {
            try fm.trashItem(at: target, resultingItemURL: nil) // an older copy: to the Trash, not deleted
        }
        if move {
            try fm.moveItem(at: source, to: target)
        } else {
            guard run("/usr/bin/ditto", [source.path, target.path]) else {
                throw UpdateError("Copying to \(folder.path) failed.")
            }
        }
        _ = run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", target.path])
        return target
    }

    /// Start the app at `url` once this instance has quit.
    func relaunch(_ url: URL) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done; open \"$0\"", url.path]
        try? p.run()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    // Closing the window only hides it: the app and its server keep running in
    // the background and keep collecting changes. Quit (⌘Q) really ends it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /** Click on the Dock icon (or open the app again): bring the window back. */
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    // MARK: Blank window protection

    /// The page runs in a separate WebKit process. If macOS ends it (memory
    /// pressure during long background hours) or it crashes, the window would
    /// stay blank. Load the page again right away instead.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("Watch Him Code: web content process ended – reloading")
        if webView.url != nil { webView.reload() }
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard let server = server, server.isRunning else { return }
        server.terminate()
        // Wait briefly so a restarted app (update) doesn't find the old server still answering.
        let deadline = Date().addingTimeInterval(2)
        while server.isRunning && Date() < deadline { usleep(50_000) }
    }

    // MARK: Window

    func buildWindow() {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "whc")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Watch Him Code"
        window.isReleasedWhenClosed = false // closing hides it, the page stays live
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
        guard let body = message.body as? [String: Any] else { return }
        if let theme = body["theme"] as? String { applyTheme(theme) }
        if let link = body["open"] as? String, let url = URL(string: link), url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        if let update = body["update"] as? [String: Any], let link = update["url"] as? String {
            installUpdate(link)
        }
        if body["titlebar"] as? String == "dblclick" { titlebarDoubleClick() }
    }

    /** Double-click on the page's title bar: do what the system setting says. */
    func titlebarDoubleClick() {
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize": window.miniaturize(nil)
        case "None": break
        default: window.zoom(nil)
        }
    }

    // MARK: Update (only when the user clicks "Install & restart")

    func reportUpdate(_ state: String, _ message: String = "") {
        let payload = (try? JSONSerialization.data(withJSONObject: ["state": state, "message": message])) ?? Data()
        let json = String(data: payload, encoding: .utf8) ?? "{}"
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript("window.whcUpdateState && window.whcUpdateState(\(json))", completionHandler: nil)
        }
    }

    func installUpdate(_ link: String) {
        // Only official release downloads from this repository.
        guard let url = URL(string: link), url.scheme == "https", url.host == "github.com",
              url.path.hasPrefix("/stfnhdr/watch-him-code/releases/download/") else {
            reportUpdate("error", "Unexpected download address.")
            return
        }
        let current = Bundle.main.bundleURL
        let folder = current.deletingLastPathComponent()
        if current.path.contains("/AppTranslocation/") {
            reportUpdate("error", "macOS runs this copy from a temporary location. Move Watch Him Code to Applications (or your Desktop), open it from there and try again.")
            return
        }
        if !FileManager.default.isWritableFile(atPath: folder.path) {
            reportUpdate("error", "No permission to replace the app in \(folder.path). Download the new version from the release page instead.")
            return
        }
        reportUpdate("downloading")
        URLSession.shared.downloadTask(with: url) { file, response, error in
            guard let file = file, error == nil, (response as? HTTPURLResponse)?.statusCode == 200 else {
                self.reportUpdate("error", "Download failed: \(error?.localizedDescription ?? "server error").")
                return
            }
            do {
                try self.replaceApp(zip: file, current: current)
            } catch {
                self.reportUpdate("error", "Update failed: \(error.localizedDescription)")
            }
        }.resume()
    }

    func run(_ tool: String, _ args: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }

    struct UpdateError: LocalizedError {
        let errorDescription: String?
        init(_ text: String) { errorDescription = text }
    }

    func replaceApp(zip: URL, current: URL) throws {
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("whc-update-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        let zipFile = work.appendingPathComponent("update.zip")
        try fm.moveItem(at: zip, to: zipFile)
        let unpacked = work.appendingPathComponent("unpacked")
        guard run("/usr/bin/ditto", ["-x", "-k", zipFile.path, unpacked.path]) else { throw UpdateError("Could not unpack the download.") }
        guard let newApp = (try fm.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: nil)).first(where: { $0.pathExtension == "app" }),
              Bundle(url: newApp)?.bundleIdentifier == Bundle.main.bundleIdentifier else {
            throw UpdateError("The download does not contain Watch Him Code.")
        }
        guard run("/usr/bin/codesign", ["--verify", "--deep", newApp.path]) else { throw UpdateError("The new app's signature is broken.") }
        _ = run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", newApp.path])

        reportUpdate("installing")
        // Swap while we are still running: a running app can be moved, and macOS
        // asks for folder access (e.g. Desktop) on our behalf.
        let backup = current.deletingLastPathComponent().appendingPathComponent(".\(current.lastPathComponent).old")
        try? fm.removeItem(at: backup)
        try fm.moveItem(at: current, to: backup)
        do {
            try fm.moveItem(at: newApp, to: current)
        } catch {
            try? fm.moveItem(at: backup, to: current)
            throw error
        }
        try? fm.removeItem(at: backup)

        // Start the new version once this one has quit.
        let script = "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.2; done; open \"$0\""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script, current.path]
        try p.run()
        DispatchQueue.main.async { NSApp.terminate(nil) }
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
        win.addItem(withTitle: "Show Watch Him Code", action: #selector(showWindow), keyEquivalent: "0")
        win.addItem(withTitle: "Close (keeps running)", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
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
        env["WHC_APP_VERSION"] = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
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
