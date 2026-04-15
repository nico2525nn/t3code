package expo.modules.t3terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3TerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3TerminalSurface")

    View(T3TerminalView::class) {
      Prop("terminalKey") { view: T3TerminalView, terminalKey: String ->
        view.terminalKey = terminalKey
      }

      Prop("initialBuffer") { view: T3TerminalView, initialBuffer: String ->
        view.initialBuffer = initialBuffer
      }

      Prop("fontSize") { view: T3TerminalView, fontSize: Double ->
        view.fontSize = fontSize.toFloat()
      }

      Events("onInput", "onResize")
    }
  }
}
