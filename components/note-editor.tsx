"use client";

import {
  useEditor,
  useEditorState,
  EditorContent,
  type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TableKit } from "@tiptap/extension-table";
import {
  useEffect,
  useId,
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
  ArrowUpRight,
  ArrowLeft,
  Maximize2,
  Table,
} from "lucide-react";
import {
  BUCKETS,
  LINK_ERROR_MESSAGES,
  itemKind,
  type Note,
  type BucketId,
  type LinkErrorCode,
  type Workspace,
} from "@/lib/notes";
import { KIND_LABELS, workspaceMoveError } from "@/lib/item-properties";
import { isAgentResult } from "@/lib/projects-view";
import { ConflictBanner, ReloadBanner } from "./conflict-banner";
import {
  AssignmentField,
  FollowupFields,
  KindField,
  ProjectContents,
  ProjectField,
  ReminderField,
  type ItemApi,
} from "./item-properties";

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
  {
    name: "Table",
    detail: "Line things up in rows and columns",
    icon: Table,
    run: (e: Editor) =>
      e
        .chain()
        .focus()
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
];

/**
 * The item editor: title, properties, Tiptap content, autosave status and
 * the conflict banner. `layout="dialog"` (default) is the modal over any
 * page, with a focus trap, Escape to close and "Open full page".
 * `layout="page"` is the same editor in the page flow (/items/[id]): no
 * backdrop, trap or scroll lock; the close control goes back instead.
 */
export function NoteEditor({
  note,
  workspaces,
  api,
  onUpdate,
  onClose,
  onDelete,
  onOpenNote,
  onToast,
  onOpenSettings,
  onOpenAgent,
  onOpenFullPage,
  storageError,
  layout = "dialog",
}: {
  note: Note;
  workspaces: Workspace[];
  /** Kinds, links, follow-ups, reminders and conflict recovery (useNotes). */
  api: ItemApi;
  onUpdate: (patch: Partial<Note>) => void;
  /** Dialog: close. Page: leave the full page (back). */
  onClose: () => void;
  /** Dialog only: show this item at /items/[id]. */
  onOpenFullPage?: () => void;
  layout?: "dialog" | "page";
  /** Deletes the note; a project with linked items asks first (Workspace). */
  onDelete: () => void;
  onOpenNote: (id: string) => void;
  onToast: (message: string) => void;
  /** Closes the editor and opens Settings (model key) or the Agent dialog. */
  onOpenSettings?: () => void;
  onOpenAgent?: () => void;
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
  const [moveError, setMoveError] = useState<LinkErrorCode | null>(null);
  const page = layout === "page";
  const labelId = `${useId()}-label`;
  const conflict = api.conflictFor(note.id);
  const itemError = api.itemErrorFor(note.id);
  const kind = itemKind(note);
  const linkedChildren = kind === "project" ? api.childrenOf(note.id).length : 0;
  // The content this editor last sent up, so a copy that arrives from
  // elsewhere (Use theirs, a refresh of a clean note) is shown.
  const contentRef = useRef(note.content);
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
      TableKit.configure({ table: { resizable: true } }),
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
      const content = e.getJSON();
      contentRef.current = content;
      onUpdateRef.current({ content, plainText: e.getText() });
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
  useEffect(() => {
    if (!editor || note.content === contentRef.current) return;
    contentRef.current = note.content;
    // Same document (a refresh re-read it): keep the cursor where it is.
    if (JSON.stringify(editor.getJSON()) === JSON.stringify(note.content)) return;
    editor.commands.setContent(note.content, { emitUpdate: false });
  }, [editor, note.content]);
  // The table controls show only while the cursor is in a table.
  const inTable = useEditorState({
    editor,
    selector: ({ editor: e }) => e?.isActive("table") ?? false,
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
    // On the full page the document scrolls, not the editor.
    window.addEventListener("scroll", positionMenu, { passive: true });
    window.addEventListener("resize", positionMenu);
    window.visualViewport?.addEventListener("resize", positionMenu);
    window.visualViewport?.addEventListener("scroll", positionMenu);
    const observer = new ResizeObserver(positionMenu);
    observer.observe(scroll);
    return () => {
      scroll.removeEventListener("scroll", positionMenu);
      window.removeEventListener("scroll", positionMenu);
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
    // The full page starts at the title and leaves page scroll and Tab alone.
    if (page) {
      titleRef.current?.focus({ preventScroll: true });
      return;
    }
    const prior = document.activeElement as HTMLElement | null;
    titleRef.current?.focus();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function trap(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input, textarea, select, [contenteditable="true"], [tabindex="0"]',
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
  }, [page]);
  const filtered = commands.filter((c) =>
    c.name.toLowerCase().includes(slash?.query.toLowerCase() || ""),
  );
  function addTag() {
    const value = tag.trim().replace(/^#/, "");
    if (value && !note.tags.includes(value))
      onUpdate({ tags: [...note.tags, value] });
    setTag("");
  }
  const editorBody = (
      <div
        className={page ? "editor-dialog is-page" : "editor-dialog"}
        ref={dialogRef}
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : "true"}
        aria-labelledby={page ? undefined : labelId}
        onKeyDown={(e) => {
          if (!page && e.key === "Escape" && !slash) {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        {page && (
          <h1 className="sr-only">{note.title.trim() || "Untitled thought"}</h1>
        )}
        <div className="editor-topbar">
          {page && (
            <button
              type="button"
              className="icon-button editor-back"
              onClick={onClose}
              aria-label="Back"
              title="Back"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <span id={labelId}>
            YOUR SPACE / {KIND_LABELS[kind].toUpperCase()}
          </span>
          <span
            className={
              storageError || conflict || itemError
                ? "save-status error-text"
                : "save-status"
            }
          >
            {!(storageError || conflict || itemError) && <Check size={13} />}
            {conflict
              ? "Kept here — choose a version"
              : itemError
                ? "A change wasn’t saved"
                : storageError
                  ? "Not saved yet — retrying"
                  : "Synced to your account"}
          </span>
          {!page && onOpenFullPage && (
            <button
              type="button"
              className="icon-button"
              onClick={onOpenFullPage}
              aria-label="Open full page"
              title="Open full page"
            >
              <Maximize2 size={16} />
            </button>
          )}
          {!page && (
            <button
              className="icon-button"
              onClick={onClose}
              aria-label="Close note"
            >
              <X size={20} />
            </button>
          )}
        </div>
        {api.reloadRequired && <ReloadBanner compact />}
        {conflict && (
          <ConflictBanner
            conflict={conflict}
            onKeepMine={() => {
              api.keepMine(note.id);
              onToast("Kept your version");
            }}
            onUseTheirs={() => {
              api.takeTheirs(note.id);
              onToast(conflict.server ? "Showing the version saved elsewhere" : "Removed here too");
            }}
            onSaveCopy={() => {
              const copy = api.saveMineAsCopy(note.id);
              if (!copy) return;
              onToast("Your version is saved as a new note");
              onOpenNote(copy);
            }}
          />
        )}
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
              <KindField note={note} api={api} />
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
              <ProjectField note={note} api={api} />
              {workspaces.length > 1 && (
                <>
                  <span>Workspace</span>
                  <div className="property-control">
                    <div className="select-wrap">
                      <select
                        aria-label="Note workspace"
                        aria-describedby={moveError ? "note-workspace-error" : undefined}
                        value={note.workspaceId}
                        onChange={(e) => {
                          // Linked items can't change space (ADR 001): unlink first.
                          const error = workspaceMoveError(api.notes, note);
                          setMoveError(error);
                          if (!error) onUpdate({ workspaceId: e.target.value });
                        }}
                      >
                        {workspaces.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={14} />
                    </div>
                    {moveError && (
                      <p className="property-error" id="note-workspace-error" role="alert">
                        {linkedChildren
                          ? "Move or unlink this project’s items before moving it to another space."
                          : LINK_ERROR_MESSAGES[moveError]}
                      </p>
                    )}
                  </div>
                </>
              )}
              {note.origin?.kind === "slack" && (
                <>
                  <span>Source</span>
                  <div className="note-source">
                    {note.origin.permalink ? (
                      <a
                        href={note.origin.permalink}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Slack
                        {note.origin.channelName &&
                          ` · #${note.origin.channelName}`}
                        <ArrowUpRight size={13} />
                      </a>
                    ) : (
                      "Slack"
                    )}
                  </div>
                </>
              )}
              {note.origin?.kind === "email" && (
                <>
                  <span>Source</span>
                  <div className="note-source">
                    <span title={note.origin.subject}>
                      Email · {note.origin.from}
                    </span>
                  </div>
                </>
              )}
              {isAgentResult(note) && (
                <>
                  <span>Source</span>
                  <div className="note-source">Agent result</div>
                </>
              )}
              <label htmlFor="note-due-date">Due date</label>
              <div className="note-due-date">
                <input
                  id="note-due-date"
                  type="date"
                  value={note.dueDate ?? ""}
                  onChange={(e) => onUpdate({ dueDate: e.target.value || null })}
                />
                {note.dueDate && <button type="button" className="icon-button" aria-label="Clear due date" onClick={() => onUpdate({ dueDate: null })}><X size={14} /></button>}
              </div>
              <FollowupFields note={note} api={api} />
              <ReminderField note={note} api={api} />
              <AssignmentField
                note={note}
                api={api}
                onOpenNote={onOpenNote}
                onOpenSettings={onOpenSettings}
                onOpenAgent={onOpenAgent}
              />
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
            <ProjectContents note={note} api={api} onOpenNote={onOpenNote} />
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
              <button
                className={inTable ? "active" : ""}
                onClick={() =>
                  editor
                    ?.chain()
                    .focus()
                    .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                    .run()
                }
                aria-label="Table"
                title="Table"
              >
                <Table size={16} />
              </button>
              <small>
                Type <kbd>/</kbd> to explore
              </small>
            </div>
            {inTable && (
              <div className="table-toolbar" role="toolbar" aria-label="Table">
                <button
                  onClick={() => editor?.chain().focus().addRowAfter().run()}
                >
                  + Row
                </button>
                <button
                  onClick={() => editor?.chain().focus().addColumnAfter().run()}
                >
                  + Column
                </button>
                <span />
                <button
                  onClick={() => editor?.chain().focus().deleteRow().run()}
                >
                  − Row
                </button>
                <button
                  onClick={() => editor?.chain().focus().deleteColumn().run()}
                >
                  − Column
                </button>
                <span />
                <button
                  onClick={() => editor?.chain().focus().toggleHeaderRow().run()}
                >
                  Header row
                </button>
                <button
                  className="table-toolbar-danger"
                  onClick={() => editor?.chain().focus().deleteTable().run()}
                >
                  Delete table
                </button>
              </div>
            )}
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
                <span>Delete this {KIND_LABELS[kind].toLowerCase()}?</span>
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
                  aria-label={`Delete ${KIND_LABELS[kind].toLowerCase()}`}
                  // A project with linked items gets its own dialog instead.
                  onClick={() => (linkedChildren ? onDelete() : setConfirmDelete(true))}
                >
                  <Trash2 size={16} />
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    onUpdate({
                      completedAt: note.completedAt
                        ? null
                        : new Date().toISOString(),
                    });
                    // The dialog closes; the full page stays to show it's done.
                    if (!note.completedAt && !page) onClose();
                  }}
                >
                  <Check size={15} />
                  {note.completedAt ? "Reopen note" : "Mark complete"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
  );
  if (page) return editorBody;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {editorBody}
    </div>
  );
}
