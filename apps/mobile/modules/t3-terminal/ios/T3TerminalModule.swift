import ExpoModulesCore

public class T3TerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3TerminalSurface")

    View(T3TerminalView.self) {
      Prop("terminalKey") { (view: T3TerminalView, terminalKey: String) in
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { (view: T3TerminalView, initialBuffer: String) in
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { (view: T3TerminalView, fontSize: Double) in
        view.fontSize = CGFloat(fontSize)
      }

      Events("onInput", "onResize")
    }
  }
}
