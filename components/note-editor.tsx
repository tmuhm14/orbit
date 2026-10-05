"use client";

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Minus,
  Code,
  Type,
  X,
  Check,
  Trash2,
  ChevronDown,
  CornerDownLeft,
  Hash,
} from "lucide-react";
import { BUCKETS, type Note, type BucketId } from "@/lib/notes";

const commands = [
  {
    name: "Text",
    detail: "Just start writing",
    icon: Type,
    run: (e: Editor) => e.chain().focus().setParagraph().run(),
  },
  {
    name: "Heading 1",
    detail: "A big idea",
    icon: Heading1,
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    name: "Heading 2",
    detail: "A little more structure",
    icon: Heading2,
    run: (e: Editor) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    name: "Bullet list",
    detail: "Keep your thoughts together",
    icon: List,
    run: (e: Editor) => e.chain().focus().toggleBulletList().run(),
  },
  {
    name: "Numbered list",
    detail: "One step at a time",
    icon: ListOrdered,
    run: (e: Editor) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    name: "To-do list",
    detail: "Make a small commitment",
    icon: CheckSquare,
    run: (e: Editor) => e.chain().focus().toggleTaskList().run(),
  },
  {
    name: "Quote",
    detail: "Words worth keeping",
    icon: Quote,
    run: (e: Editor) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    name: "Divider",
    detail: "Give your ideas some space",
    icon: Minus,
    run: (e: Editor) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    name: "Code block",
    detail: "A place for your snippets",
    icon: Code,
    run: (e: Editor) => e.chain().focus().toggleCodeBlock().run(),
  },
];

export function NoteEditor({
  note,
  onUpdate,
  onClose,
  onDelete,
  storageError,
}: {
  note: Note;
  onUpdate: (patch: Partial<Note>) => void;
  onClose: () => void;
  onDelete: () => void;
  storageError: boolean;
}) {
  const [slash, setSlash] = useState<{
    from: number;
    to: number;
    query: string;
  } | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [tag, setTag] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<CSSProperties>({
    visibility: "hidden",
  });
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const menuRef = useRef({ slash, commandIndex });
  menuRef.current = { slash, commandIndex };
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: "Let your thoughts land here. Type / for commands…",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content: note.content,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "note-prose",
        "aria-label": "Note content",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleKeyDown: (view, event) => {
        const state = menuRef.current;
        if (!state.slash) return false;
        const matches = commands.filter((c) =>
          c.name.toLowerCase().includes(state.slash!.query.toLowerCase()),
        );
        if (event.key === "Escape") {
          setSlash(null);
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setCommandIndex(
            (i) =>
              (i + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
              (matches.length || 1),
          );
          return true;
        }
        if (event.key === "Enter" && matches.length) {
          event.preventDefault();
          const command = matches[state.commandIndex % matches.length];
          view.dispatch(view.state.tr.delete(state.slash.from, state.slash.to));
          command.run(editor!);
          setSlash(null);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      onUpdateRef.current({ content: e.getJSON(), plainText: e.getText() });
      const { $from } = e.state.selection;
      const text = $from.parent.textBetween(0, $from.parentOffset, " ");
      const match = text.match(/(?:^|\s)\/([a-zA-Z0-9 -]*)$/);
      if (match) {
        setSlash({
          from: $from.pos - match[1].length - 1,
          to: $from.pos,
          query: match[1],
        });
        setCommandIndex(0);
      } else setSlash(null);
    },
    onSelectionUpdate: () => setSlash(null),
  });
  // Render over the document rather than after its minimum-height content.
  // Coordinates stay relative to the dialog, including while it animates in.
  useLayoutEffect(() => {
    if (!slash || !editor) return;
    const dialog = dialogRef.current;
    const scroll = scrollRef.current;
    const menu = slashMenuRef.current;
    if (!dialog || !scroll || !menu) return;
    function positionMenu() {
      if (!dialog || !scroll || !menu || !editor || !slash) return;
      const caret = editor.view.coordsAtPos(slash.from);
      const bounds = scroll.getBoundingClientRect();
      const origin = dialog.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = Math.max(bounds.top, viewport?.offsetTop ?? 0) + 8;
      const bottom =
        Math.min(
          bounds.bottom,
          (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
        ) - 8;
      if (caret.bottom < top || caret.top > bottom) {
        setMenuPosition({ visibility: "hidden" });
        return;
      }
      const below = Math.max(0, bottom - caret.bottom - 6);
      const above = Math.max(0, caret.top - top - 6);
      const desiredHeight = Math.min(310, menu.scrollHeight + 2);
      const openBelow = below >= desiredHeight || below >= above;
      const height = Math.min(desiredHeight, openBelow ? below : above);
      const width = Math.min(285, bounds.width - 24);
      const left = Math.max(
        bounds.left + 12,
        Math.min(caret.left, bounds.right - width - 12),
      );
      setMenuPosition({
        visibility: "visible",
        left: left - origin.left - dialog.clientLeft,
        top:
          (openBelow ? caret.bottom + 6 : caret.top - height - 6) -
          origin.top -
          dialog.clientTop,
        width,
        maxHeight: height,
      });
    }
    positionMenu();
    scroll.addEventListener("scroll", positionMenu, { passive: true });
    window.addEventListener("resize", positionMenu);
    window.visualViewport?.addEventListener("resize", positionMenu);
    window.visualViewport?.addEventListener("scroll", positionMenu);
    const observer = new ResizeObserver(positionMenu);
    observer.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", positionMenu);
      window.removeEventListener("resize", positionMenu);
      window.visualViewport?.removeEventListener("resize", positionMenu);
      window.visualViewport?.removeEventListener("scroll", positionMenu);
      observer.disconnect();
    };
  }, [editor, slash]);

  useLayoutEffect(() => {
    const menu = slashMenuRef.current;
    const option = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !option) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      menu.scrollTop + menu.clientHeight
    )
      menu.scrollTop =
        option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [commandIndex, slash]);

  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    titleRef.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function trap(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, textarea, select, [contenteditable="true"], [tabindex="0"]',
      );
      if (!elements?.length) return;
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", trap);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", trap);
      prior?.focus();
    };
  }, []);
  const filtered = commands.filter((c) =>
    c.name.toLowerCase().includes(slash?.query.toLowerCase() || ""),
  );
  function addTag() {
    const value = tag.trim().replace(/^#/, "");
    if (value && !note.tags.includes(value))
      onUpdate({ tags: [...note.tags, value] });
    setTag("");
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="editor-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-dialog-label"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !slash) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="editor-topbar">
          <span id="note-dialog-label">YOUR SPACE / NOTE</span>
          <span
            className={storageError ? "save-status error-text" : "save-status"}
          >
            <Check size={13} />
            {storageError
              ? "Not saved — export a backup"
              : "Saved on this device"}
          </span>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close note"
          >
            <X size={20} />
          </button>
        </div>
        <div className="editor-scroll" ref={scrollRef}>
          <div className="editor-cover">
            <div className="mini-orbit" />
            <span>ROOM TO THINK</span>
          </div>
          <div className="editor-document">
            <textarea
              ref={titleRef}
              className="note-title-input"
              rows={2}
              aria-label="Note title"
              placeholder="Untitled thought"
              value={note.title}
              onChange={(e) => onUpdate({ title: e.target.value })}
            />
            <div className="note-properties">
              <span>Bucket</span>
              <div className="select-wrap">
                <span
                  className={`tiny-dot ${BUCKETS.find((b) => b.id === note.bucket)?.color}`}
                />
                <select
                  aria-label="Note bucket"
                  value={note.bucket}
                  onChange={(e) =>
                    onUpdate({ bucket: e.target.value as BucketId })
                  }
                >
                  {BUCKETS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </div>
              <span>Tags</span>
              <div className="tag-editor">
                {note.tags.map((t) => (
                  <button
                    className="tag"
                    key={t}
                    onClick={() =>
                      onUpdate({ tags: note.tags.filter((x) => x !== t) })
                    }
                    aria-label={`Remove tag ${t}`}
                  >
                    {t}
                    <X size={11} />
                  </button>
                ))}
                <input
                  aria-label="Add tag"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                  onBlur={addTag}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                  placeholder="+ Add a tag"
                />
              </div>
            </div>
            <div className="format-toolbar" aria-label="Text formatting">
              <button
                className={editor?.isActive("bold") ? "active" : ""}
                onClick={() => editor?.chain().focus().toggleBold().run()}
                aria-label="Bold"
              >
                <Bold size={16} />
              </button>
              <button
                className={editor?.isActive("italic") ? "active" : ""}
                onClick={() => editor?.chain().focus().toggleItalic().run()}
                aria-label="Italic"
              >
                <Italic size={16} />
              </button>
              <span />
              <button
                onClick={() =>
                  editor?.chain().focus().toggleHeading({ level: 2 }).run()
                }
                aria-label="Heading"
              >
                <Heading2 size={17} />
              </button>
              <button
                onClick={() => editor?.chain().focus().toggleBulletList().run()}
                aria-label="Bullet list"
              >
                <List size={17} />
              </button>
              <button
                onClick={() => editor?.chain().focus().toggleTaskList().run()}
                aria-label="Checklist"
              >
                <CheckSquare size={16} />
              </button>
              <button
                onClick={() => editor?.chain().focus().toggleBlockquote().run()}
                aria-label="Quote"
              >
                <Quote size={16} />
              </button>
              <small>
                Type <kbd>/</kbd> to explore
              </small>
            </div>
            <div className="editor-content-wrap">
              <EditorContent editor={editor} />
              {slash &&
                dialogRef.current &&
                createPortal(
                  <div
                    ref={slashMenuRef}
                    style={menuPosition}
                    className="slash-menu"
                    role="listbox"
                    aria-label="Slash commands"
                  >
                    <div className="slash-menu-label">
                      ADD A BLOCK <CornerDownLeft size={12} />
                    </div>
                    {filtered.length ? (
                      filtered.map((c, i) => (
                        <button
                          role="option"
                          aria-selected={commandIndex === i}
                          className={commandIndex === i ? "selected" : ""}
                          key={c.name}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            editor
                              ?.chain()
                              .focus()
                              .deleteRange({ from: slash.from, to: slash.to })
                              .run();
                            if (editor) c.run(editor);
                            setSlash(null);
                          }}
                        >
                          <span className="command-icon">
                            <c.icon size={18} />
                          </span>
                          <span>
                            <strong>{c.name}</strong>
                            <small>{c.detail}</small>
                          </span>
                        </button>
                      ))
                    ) : (
                      <p>No matching blocks.</p>
                    )}
                  </div>,
                  dialogRef.current,
                )}
            </div>
          </div>
        </div>
        <div className="editor-footer">
          <span>
            <Hash size={13} />
            {note.plainText.trim()
              ? note.plainText.trim().split(/\s+/).length
              : 0}{" "}
            words
          </span>
          <div>
            {confirmDelete ? (
              <>
                <span>Delete this note?</span>
                <button
                  className="text-button"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
                <button className="danger-button" onClick={onDelete}>
                  Delete
                </button>
              </>
            ) : (
              <>
                <button
                  className="icon-button"
                  aria-label="Delete note"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={16} />
                </button>
                <button
                  className="secondary-button"
                  onClick={() =>
                    onUpdate({
                      completedAt: note.completedAt
                        ? null
                        : new Date().toISOString(),
                    })
                  }
                >
                  <Check size={15} />
                  {note.completedAt ? "Reopen note" : "Mark complete"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
