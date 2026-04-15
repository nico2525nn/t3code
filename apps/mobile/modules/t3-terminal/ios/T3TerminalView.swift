import ExpoModulesCore
import GhosttyKit
import QuartzCore
import UIKit

private enum GhosttyRuntime {
  private static let lock = NSLock()
  private static var initialized = false

  static func ensureInitialized() -> Bool {
    lock.lock()
    defer { lock.unlock() }

    if initialized {
      return true
    }

    let result = ghostty_init(0, nil)
    initialized = result == GHOSTTY_SUCCESS
    return initialized
  }
}

public final class T3TerminalView: ExpoView, UITextFieldDelegate {
  private let terminalViewport = UIView()
  private let inputField = UITextField()
  private let inputDivider = UIView()
  private var lastViewportSize: CGSize = .zero
  private var lastContentScale: CGFloat = 0
  private var lastReportedGrid: (cols: Int, rows: Int)?
  private var lastAppliedBuffer = ""
  private var app: ghostty_app_t?
  private var surface: ghostty_surface_t?
  private var isCreatingSurface = false
  private var surfaceCreationFailed = false

  let onInput = EventDispatcher()
  let onResize = EventDispatcher()

  var terminalKey: String = "" {
    didSet {
      accessibilityIdentifier = "t3-terminal-\(terminalKey)"
      if oldValue != terminalKey {
        resetSurface()
      }
    }
  }

  var initialBuffer: String = "" {
    didSet {
      applyRemoteBuffer(initialBuffer)
    }
  }

  var fontSize: CGFloat = 12 {
    didSet {
      inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
      resetSurface()
    }
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    backgroundColor = UIColor.black
    clipsToBounds = true
    contentScaleFactor = UIScreen.main.scale

    terminalViewport.backgroundColor = UIColor.black
    terminalViewport.clipsToBounds = true
    terminalViewport.contentScaleFactor = contentScaleFactor
    terminalViewport.translatesAutoresizingMaskIntoConstraints = false

    inputDivider.backgroundColor = UIColor(white: 1, alpha: 0.12)
    inputDivider.translatesAutoresizingMaskIntoConstraints = false

    inputField.delegate = self
    inputField.backgroundColor = UIColor.black
    inputField.textColor = UIColor(white: 0.96, alpha: 1)
    inputField.tintColor = UIColor(white: 0.96, alpha: 1)
    inputField.font = UIFont.monospacedSystemFont(ofSize: max(fontSize, 13), weight: .regular)
    inputField.placeholder = "type and press return"
    inputField.attributedPlaceholder = NSAttributedString(
      string: "type and press return",
      attributes: [.foregroundColor: UIColor(white: 0.45, alpha: 1)]
    )
    inputField.autocorrectionType = .no
    inputField.autocapitalizationType = .none
    inputField.spellCheckingType = .no
    inputField.smartDashesType = .no
    inputField.smartQuotesType = .no
    inputField.returnKeyType = .send
    inputField.translatesAutoresizingMaskIntoConstraints = false

    addSubview(terminalViewport)
    addSubview(inputDivider)
    addSubview(inputField)

    NSLayoutConstraint.activate([
      terminalViewport.leadingAnchor.constraint(equalTo: leadingAnchor),
      terminalViewport.trailingAnchor.constraint(equalTo: trailingAnchor),
      terminalViewport.topAnchor.constraint(equalTo: topAnchor),
      terminalViewport.bottomAnchor.constraint(equalTo: inputDivider.topAnchor),

      inputDivider.leadingAnchor.constraint(equalTo: leadingAnchor),
      inputDivider.trailingAnchor.constraint(equalTo: trailingAnchor),
      inputDivider.bottomAnchor.constraint(equalTo: inputField.topAnchor),
      inputDivider.heightAnchor.constraint(equalToConstant: 1),

      inputField.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
      inputField.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
      inputField.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
      inputField.heightAnchor.constraint(equalToConstant: 32),
    ])
  }

  deinit {
    destroySurface()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    updateContentScale()

    let viewportSize = terminalViewport.bounds.size
    if surface == nil {
      createSurfaceIfPossible()
    }

    guard viewportSize != lastViewportSize || contentScaleFactor != lastContentScale else {
      return
    }

    lastViewportSize = viewportSize
    lastContentScale = contentScaleFactor
    resizeSurface()
  }

  public func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    let text = textField.text ?? ""
    if !text.isEmpty {
      onInput(["data": "\(text)\n"])
      textField.text = ""
    }
    return false
  }

  private func createSurfaceIfPossible() {
    guard surface == nil, app == nil, !isCreatingSurface, !surfaceCreationFailed else { return }
    guard terminalViewport.bounds.width > 0, terminalViewport.bounds.height > 0 else { return }
    guard GhosttyRuntime.ensureInitialized() else {
      surfaceCreationFailed = true
      return
    }

    isCreatingSurface = true
    defer { isCreatingSurface = false }

    var runtimeConfig = ghostty_runtime_config_s(
      userdata: Unmanaged.passUnretained(self).toOpaque(),
      supports_selection_clipboard: false,
      wakeup_cb: { _ in },
      action_cb: { _, _, _ in false },
      read_clipboard_cb: { _, _, _ in },
      confirm_read_clipboard_cb: { _, _, _, _ in },
      write_clipboard_cb: { _, _, _, _, _ in },
      close_surface_cb: { _, _ in }
    )

    guard let config = ghostty_config_new() else {
      surfaceCreationFailed = true
      return
    }
    ghostty_config_finalize(config)
    defer { ghostty_config_free(config) }

    guard let createdApp = ghostty_app_new(&runtimeConfig, config) else {
      surfaceCreationFailed = true
      return
    }

    var surfaceConfig = ghostty_surface_config_new()
    surfaceConfig.platform_tag = GHOSTTY_PLATFORM_IOS
    surfaceConfig.platform.ios.uiview = Unmanaged.passUnretained(terminalViewport).toOpaque()
    surfaceConfig.userdata = Unmanaged.passUnretained(self).toOpaque()
    surfaceConfig.scale_factor = Double(contentScaleFactor)
    surfaceConfig.font_size = Float(fontSize)
    surfaceConfig.context = GHOSTTY_SURFACE_CONTEXT_WINDOW
    surfaceConfig.use_custom_io = true

    guard let createdSurface = ghostty_surface_new(createdApp, &surfaceConfig) else {
      ghostty_app_free(createdApp)
      surfaceCreationFailed = true
      return
    }

    app = createdApp
    surface = createdSurface
    setupWriteCallback()
    resizeSurface()
    feedBuffer(initialBuffer)
  }

  private func resetSurface() {
    destroySurface()
    lastAppliedBuffer = ""
    lastViewportSize = .zero
    lastContentScale = 0
    lastReportedGrid = nil
    surfaceCreationFailed = false
    setNeedsLayout()
  }

  private func destroySurface() {
    if let surface {
      ghostty_surface_set_write_callback(surface, nil, nil)
      ghostty_surface_free(surface)
    }
    if let app {
      ghostty_app_free(app)
    }
    surface = nil
    app = nil
  }

  private func applyRemoteBuffer(_ buffer: String) {
    guard surface != nil else {
      createSurfaceIfPossible()
      return
    }

    if buffer.hasPrefix(lastAppliedBuffer) {
      let suffix = String(buffer.dropFirst(lastAppliedBuffer.count))
      feedData(Data(suffix.utf8))
      lastAppliedBuffer = buffer
      return
    }

    resetSurface()
    createSurfaceIfPossible()
  }

  private func feedBuffer(_ buffer: String) {
    guard !buffer.isEmpty else { return }
    feedData(Data(buffer.utf8))
    lastAppliedBuffer = buffer
  }

  private func feedData(_ data: Data) {
    guard let surface, !data.isEmpty else { return }

    data.withUnsafeBytes { buffer in
      guard let pointer = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
        return
      }
      ghostty_surface_feed_data(surface, pointer, buffer.count)
    }

    redrawSurface()
  }

  private func setupWriteCallback() {
    guard let surface else { return }

    let userdata = Unmanaged.passUnretained(self).toOpaque()
    ghostty_surface_set_write_callback(surface, { userdata, data, len in
      guard let userdata, let data, len > 0 else { return }
      let view = Unmanaged<T3TerminalView>.fromOpaque(userdata).takeUnretainedValue()
      let bytes = Data(bytes: data, count: len)
      guard let input = String(data: bytes, encoding: .utf8), !input.isEmpty else { return }

      DispatchQueue.main.async {
        view.onInput(["data": input])
      }
    }, userdata)
  }

  private func resizeSurface() {
    guard let surface else {
      emitEstimatedResize()
      return
    }

    let scale = contentScaleFactor
    let width = UInt32(max(floor(terminalViewport.bounds.width * scale), 1))
    let height = UInt32(max(floor(terminalViewport.bounds.height * scale), 1))

    terminalViewport.contentScaleFactor = scale
    ghostty_surface_set_content_scale(surface, Double(scale), Double(scale))
    ghostty_surface_set_size(surface, width, height)
    ghostty_surface_set_occlusion(surface, window != nil)
    configureIOSurfaceLayers()
    redrawSurface()
    emitGhosttyResize()
  }

  private func redrawSurface() {
    guard let surface else { return }
    ghostty_surface_refresh(surface)
    ghostty_surface_draw(surface)
    markIOSurfaceLayersForDisplay()
    emitGhosttyResize()
  }

  private func emitGhosttyResize() {
    guard let surface else {
      emitEstimatedResize()
      return
    }

    let size = ghostty_surface_size(surface)
    let cols = max(1, Int(size.columns))
    let rows = max(1, Int(size.rows))
    emitResize(cols: cols, rows: rows)
  }

  private func emitEstimatedResize() {
    guard bounds.width > 0, bounds.height > 0 else { return }

    let cellWidth = max(fontSize * 0.62, 1)
    let cellHeight = max(fontSize * 1.35, 1)
    let cols = max(20, min(400, Int(bounds.width / cellWidth)))
    let terminalHeight = max(bounds.height - 41, 0)
    let rows = max(5, min(200, Int(terminalHeight / cellHeight)))
    emitResize(cols: cols, rows: rows)
  }

  private func emitResize(cols: Int, rows: Int) {
    guard lastReportedGrid?.cols != cols || lastReportedGrid?.rows != rows else {
      return
    }

    lastReportedGrid = (cols, rows)
    onResize([
      "cols": cols,
      "rows": rows,
    ])
  }

  private func updateContentScale() {
    let scale = window?.screen.scale ?? UIScreen.main.scale
    if contentScaleFactor != scale {
      contentScaleFactor = scale
    }
  }

  private func configureIOSurfaceLayers() {
    let targetBounds = CGRect(origin: .zero, size: terminalViewport.bounds.size)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    terminalViewport.layer.sublayers?.forEach { sublayer in
      sublayer.frame = targetBounds
      sublayer.contentsScale = contentScaleFactor
    }
    CATransaction.commit()
  }

  private func markIOSurfaceLayersForDisplay() {
    terminalViewport.layer.setNeedsDisplay()
    terminalViewport.layer.sublayers?.forEach { layer in
      layer.setNeedsDisplay()
    }
  }
}
