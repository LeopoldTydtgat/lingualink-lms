import type { Editor } from '@tiptap/react'

// Reads the editor's HTML for sending or saving.
//
// Tiptap's autolink (StarterKit Link) turns a URL into a link only once
// whitespace follows it, so a URL typed last before Send stays plain text.
// This inserts one space at the end of the last text block that has any
// content, which is an ordinary editor transaction: autolink runs exactly as
// it does when the user types a space and links the URL if there is one.
// The space is then deleted again. Autolink only ever adds marks, so the
// link survives and the document is otherwise exactly what it was.
//
// The last NON-EMPTY block is targeted, not the document end: StarterKit's
// TrailingNode keeps an empty paragraph after a list or heading, and a space
// dropped in there has no word before it to link.
//
// Empty documents are returned untouched so the callers' emptiness check
// sees exactly what it always did.
export function readEditorHtml(editor: Editor): string {
  if (editor.isEmpty) return editor.getHTML()
  // -1 rather than null: TypeScript does not track assignments made inside
  // the descendants callback, so a nullable would narrow to never below.
  let insertAt = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.content.size > 0) {
      // End of this block's content; the last match wins.
      insertAt = pos + node.nodeSize - 1
    }
    return true
  })
  if (insertAt < 0) return editor.getHTML()
  const at = insertAt
  editor.commands.command(({ tr, dispatch }) => {
    if (dispatch) tr.insertText(' ', at)
    return true
  })
  editor.commands.command(({ tr, dispatch }) => {
    if (dispatch) tr.delete(at, at + 1)
    return true
  })
  return editor.getHTML()
}
