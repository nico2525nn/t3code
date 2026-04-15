package expo.modules.t3terminal

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import kotlin.math.max
import kotlin.math.min

class T3TerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val container = LinearLayout(context)
  private val scrollView = ScrollView(context)
  private val textView = TextView(context)
  private val inputView = EditText(context)
  private val onInput by EventDispatcher()
  private val onResize by EventDispatcher()
  private var lastWidth = 0
  private var lastHeight = 0

  var terminalKey: String = ""
    set(value) {
      field = value
      contentDescription = "t3-terminal-$value"
    }

  var initialBuffer: String = ""
    set(value) {
      field = value
      textView.text = value.ifEmpty { "$ " }
      scrollView.post {
        scrollView.fullScroll(View.FOCUS_DOWN)
      }
    }

  var fontSize: Float = 12f
    set(value) {
      field = value
      textView.textSize = value
      emitResize()
    }

  init {
    setBackgroundColor(Color.BLACK)
    container.orientation = LinearLayout.VERTICAL
    container.setBackgroundColor(Color.BLACK)

    textView.setTextColor(Color.rgb(245, 245, 245))
    textView.typeface = Typeface.MONOSPACE
    textView.textSize = fontSize
    textView.setPadding(8, 8, 8, 8)
    textView.text = "$ "

    inputView.setSingleLine(true)
    inputView.setTextColor(Color.rgb(245, 245, 245))
    inputView.setHintTextColor(Color.rgb(115, 115, 115))
    inputView.setBackgroundColor(Color.BLACK)
    inputView.typeface = Typeface.MONOSPACE
    inputView.textSize = max(fontSize, 13f)
    inputView.hint = "type and press return"
    inputView.imeOptions = EditorInfo.IME_ACTION_SEND
    inputView.setPadding(8, 0, 8, 8)
    inputView.setOnEditorActionListener { view, actionId, _ ->
      if (actionId != EditorInfo.IME_ACTION_SEND) return@setOnEditorActionListener false
      val text = view.text?.toString().orEmpty()
      if (text.isNotEmpty()) {
        onInput(mapOf("data" to "$text\n"))
        view.text?.clear()
      }
      true
    }

    scrollView.addView(
      textView,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
    )
    container.addView(
      scrollView,
      LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        0,
        1f,
      ),
    )
    container.addView(
      inputView,
      LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 48),
    )
    addView(
      container,
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    if (width == lastWidth && height == lastHeight) return
    lastWidth = width
    lastHeight = height
    emitResize()
  }

  private fun emitResize() {
    if (width <= 0 || height <= 0) return
    val density = resources.displayMetrics.scaledDensity
    val fontPx = max(fontSize * density, 1f)
    val cols = max(20, min(400, (width / (fontPx * 0.62f)).toInt()))
    val terminalHeight = max(height - inputView.height, 0)
    val rows = max(5, min(200, (terminalHeight / (fontPx * 1.35f)).toInt()))
    onResize(mapOf("cols" to cols, "rows" to rows))
  }
}
