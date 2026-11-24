import React, { useMemo, useState } from 'react';
import {
  Plus,
  Search,
  CheckCircle2,
  Trash2,
  Play,
  ArrowRight,
  ListChecks,
} from 'lucide-react';
import {
  createManualTask,
  deleteTask,
  updateTaskStatus,
} from '../lib/firestoreVault';
import { formatTimecode } from '../lib/formatters';
import type {
  MeetingFolder,
  MeetingRecord,
  ProjectTask,
  TaskPriority,
  TaskStatus,
} from '../types';

interface ProjectDashboardViewProps {
  uid: string;
  masterKey: CryptoKey;
  tasks: ProjectTask[];
  meetings: MeetingRecord[];
  folders: MeetingFolder[];
  onJumpToMeetingTimestamp: (meetingId: string, sec: number) => void;
}

const COLUMNS: Array<{ id: TaskStatus; label: string }> = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'in_review', label: 'In Review' },
  { id: 'done', label: 'Done' },
];

const PRIORITY_STYLES: Record<TaskPriority, { label: string; className: string }> = {
  urgent: { label: 'Urgent', className: 'text-red-700 font-semibold' },
  high: { label: 'High', className: 'text-amber-700 font-medium' },
  medium: { label: 'Medium', className: 'text-slate-700 font-medium' },
  low: { label: 'Low', className: 'text-slate-500' },
};

export const ProjectDashboardView: React.FC<ProjectDashboardViewProps> = ({
  uid,
  masterKey,
  tasks,
  meetings,
  folders,
  onJumpToMeetingTimestamp,
}) => {
  const [viewMode, setViewMode] = useState<'board' | 'table'>('board');
  const [searchQuery, setSearchQuery] = useState('');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [folderFilter, setFolderFilter] = useState<string>('all');

  const [showNewForm, setShowNewForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newPriority, setNewPriority] = useState<TaskPriority>('medium');
  const [newDueDate, setNewDueDate] = useState('');
  const [newFolderId, setNewFolderId] = useState('');

  const meetingMap = useMemo(() => {
    const map = new Map<string, MeetingRecord>();
    meetings.forEach((m) => map.set(m.id, m));
    return map;
  }, [meetings]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tasks.filter((t) => {
      if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
      if (folderFilter !== 'all' && t.folderId !== folderFilter) return false;
      if (!q) return true;
      return (
        t.payload.title.toLowerCase().includes(q) ||
        t.payload.description.toLowerCase().includes(q) ||
        t.payload.assignee.toLowerCase().includes(q) ||
        t.payload.meetingTitle.toLowerCase().includes(q)
      );
    });
  }, [tasks, priorityFilter, folderFilter, searchQuery]);

  const stats = useMemo(() => {
    const total = tasks.length;
    const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
    const urgentOrHigh = tasks.filter(
      (t) => t.status !== 'done' && (t.priority === 'urgent' || t.priority === 'high')
    ).length;
    const done = tasks.filter((t) => t.status === 'done').length;
    return { total, inProgress, urgentOrHigh, done };
  }, [tasks]);

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    await createManualTask({
      uid,
      masterKey,
      folderId: newFolderId,
      status: 'backlog',
      priority: newPriority,
      dueDate: newDueDate,
      payload: {
        title: newTitle.trim(),
        description: newDescription.trim(),
        assignee: newAssignee.trim() || 'Unassigned',
        category: 'Manual Task',
        meetingTitle: '',
        timestampLabel: '00:00',
      },
    });
    setNewTitle('');
    setNewDescription('');
    setNewAssignee('');
    setNewDueDate('');
    setShowNewForm(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Project Management Dashboard
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Manage tasks and follow-ups linked to your encrypted meeting recordings.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowNewForm((v) => !v)}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 self-start"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Task</span>
        </button>
      </div>

      {/* 4-column Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-xl divide-y sm:divide-y-0 sm:divide-x divide-slate-200">
        <div className="p-4">
          <div className="text-xs text-slate-500">Total Action Items</div>
          <div className="mt-1 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {stats.total}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">In Progress</div>
          <div className="mt-1 font-mono tabular-nums text-2xl font-semibold text-blue-600">
            {stats.inProgress}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">High & Urgent Open</div>
          <div className="mt-1 font-mono tabular-nums text-2xl font-semibold text-amber-700">
            {stats.urgentOrHigh}
          </div>
        </div>
        <div className="p-4">
          <div className="text-xs text-slate-500">Completed</div>
          <div className="mt-1 font-mono tabular-nums text-2xl font-semibold text-emerald-700">
            {stats.done}
          </div>
        </div>
      </div>

      {showNewForm && (
        <form
          onSubmit={handleCreateTask}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">Task Title</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Finalize Q4 API security review"
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Assignee</label>
              <input
                type="text"
                value={newAssignee}
                onChange={(e) => setNewAssignee(e.target.value)}
                placeholder="Name or team"
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Priority</label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as TaskPriority)}
                className="w-full px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label className="block text-xs font-medium text-slate-700 mb-1">Due Date</label>
              <input
                type="date"
                value={newDueDate}
                onChange={(e) => setNewDueDate(e.target.value)}
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Folder</label>
              <select
                value={newFolderId}
                onChange={(e) => setNewFolderId(e.target.value)}
                className="w-full px-3 py-1.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              >
                <option value="">All / General</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Notes</label>
              <input
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Context or deliverable details"
                className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNewForm(false)}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800"
            >
              Add Task
            </button>
          </div>
        </form>
      )}

      {/* Filter & View Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex-1 min-w-[220px] relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter tasks by title, assignee, or meeting..."
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
          >
            <option value="all">All Priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <select
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
          >
            <option value="all">All Folders</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>

          <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setViewMode('board')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                viewMode === 'board'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Board
            </button>
            <button
              type="button"
              onClick={() => setViewMode('table')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                viewMode === 'table'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      {filteredTasks.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl py-14 px-6 text-center">
          <ListChecks className="w-7 h-7 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-slate-800">No project tasks yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Create tasks with the New Task button above to track follow-ups from your recorded meetings.
          </p>
        </div>
      ) : viewMode === 'board' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
          {COLUMNS.map((col) => {
            const colTasks = filteredTasks.filter((t) => t.status === col.id);
            return (
              <div
                key={col.id}
                className="bg-slate-100/70 border border-slate-200 rounded-xl p-3 space-y-2.5"
              >
                <div className="flex items-center justify-between px-1 py-1">
                  <span className="text-xs font-semibold text-slate-800">{col.label}</span>
                  <span className="font-mono tabular-nums text-xs text-slate-500">
                    {colTasks.length}
                  </span>
                </div>

                {colTasks.map((task) => {
                  const priorityMeta = PRIORITY_STYLES[task.priority];
                  const sourceMeeting = meetingMap.get(task.meetingId);
                  return (
                    <div
                      key={task.id}
                      className="bg-white border border-slate-200 rounded-lg p-3.5 space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-medium text-slate-900 leading-snug">
                          {task.payload.title}
                        </h3>
                        <button
                          type="button"
                          onClick={() => void deleteTask(uid, task.id)}
                          className="text-slate-300 hover:text-red-600 shrink-0"
                          aria-label="Delete task"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {task.payload.description && (
                        <p className="text-xs text-slate-600 leading-relaxed line-clamp-2">
                          {task.payload.description}
                        </p>
                      )}

                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                        <span className={priorityMeta.className}>
                          {priorityMeta.label}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{task.payload.assignee}</span>
                        {task.dueDate && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">{task.dueDate}</span>
                          </>
                        )}
                      </div>

                      {sourceMeeting && (
                        <button
                          type="button"
                          onClick={() =>
                            onJumpToMeetingTimestamp(sourceMeeting.id, task.timestampSec)
                          }
                          className="w-full flex items-center justify-between px-2 py-1.5 bg-slate-50 hover:bg-blue-50/60 border border-slate-200/80 rounded-md text-[11px] text-slate-700 transition-colors"
                        >
                          <span className="truncate flex items-center gap-1.5">
                            <Play className="w-2.5 h-2.5 text-blue-600 fill-current shrink-0" />
                            <span className="truncate">{sourceMeeting.payload.title}</span>
                          </span>
                          <span className="font-mono tabular-nums text-blue-600 shrink-0 ml-2">
                            {formatTimecode(task.timestampSec)}
                          </span>
                        </button>
                      )}

                      <div className="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                        <select
                          value={task.status}
                          onChange={(e) =>
                            void updateTaskStatus(uid, task.id, e.target.value as TaskStatus)
                          }
                          className="text-[11px] text-slate-700 bg-slate-50 border border-slate-200 rounded px-2 py-1 focus:outline-none focus:border-blue-600"
                        >
                          {COLUMNS.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>

                        {task.status !== 'done' && (
                          <button
                            type="button"
                            onClick={() => void updateTaskStatus(uid, task.id, 'done')}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:text-emerald-800"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Complete
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-50/70">
                <th className="py-2.5 px-4">Task</th>
                <th className="py-2.5 px-4">Assignee</th>
                <th className="py-2.5 px-4">Priority</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Due</th>
                <th className="py-2.5 px-4">Source Meeting</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {filteredTasks.map((task) => {
                const priorityMeta = PRIORITY_STYLES[task.priority];
                const sourceMeeting = meetingMap.get(task.meetingId);
                return (
                  <tr key={task.id} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 max-w-xs">
                      <div className="font-medium text-slate-900 truncate">{task.payload.title}</div>
                      {task.payload.description && (
                        <div className="text-slate-500 truncate">{task.payload.description}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-slate-700 whitespace-nowrap">
                      {task.payload.assignee}
                    </td>
                    <td className={`py-2.5 px-4 whitespace-nowrap ${priorityMeta.className}`}>
                      {priorityMeta.label}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      <select
                        value={task.status}
                        onChange={(e) =>
                          void updateTaskStatus(uid, task.id, e.target.value as TaskStatus)
                        }
                        className="text-xs bg-white border border-slate-200 rounded px-2 py-1"
                      >
                        {COLUMNS.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                      {task.dueDate || '—'}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap">
                      {sourceMeeting ? (
                        <button
                          type="button"
                          onClick={() =>
                            onJumpToMeetingTimestamp(sourceMeeting.id, task.timestampSec)
                          }
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline font-medium"
                        >
                          <span className="truncate max-w-[140px]">
                            {sourceMeeting.payload.title}
                          </span>
                          <span className="font-mono tabular-nums">
                            ({formatTimecode(task.timestampSec)})
                          </span>
                          <ArrowRight className="w-3 h-3" />
                        </button>
                      ) : (
                        <span className="text-slate-400">Manual</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => void deleteTask(uid, task.id)}
                        className="p-1 text-slate-400 hover:text-red-600"
                        aria-label="Delete task"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
