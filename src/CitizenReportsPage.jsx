import { useState, useEffect, useCallback, Fragment } from "react";
import { supabase } from "./supabaseClient";

// Status vocabulary matches CitizenReportService._statusMessage() in the
// mobile app exactly, so a status set here maps to the message residents see.
const STATUS_OPTIONS = ["received", "assigned", "in_progress", "resolved", "closed"];

const statusColors = {
  received: "bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300",
  assigned: "bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300",
  in_progress: "bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-300",
  resolved: "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300",
  closed: "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300",
};

const statusLabel = (s) => (s || "received").replace("_", " ");

// severity comes from the mobile app's ML triage (see
// AiTriageService.classifySeverity() / SeverityResult.toPriorityLevel())
// — always exactly one of these three, when set at all.
const SEVERITY_ORDER = { High: 0, Medium: 1, Low: 2 };
const severityColors = {
  High: "bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300",
  Medium: "bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300",
  Low: "bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300",
};

// Mirrors CitizenReportService._statusMessage() in the mobile app so the
// wording a resident sees in their in-app notification matches what
// they'd see if they pulled up the report's status manually.
const REPORT_STATUS_MESSAGES = {
  received: "Your report has been received and is awaiting assignment.",
  assigned: "Your report has been assigned to a department for action.",
  in_progress: "A department is currently working on your report.",
  resolved: "Good news — the issue you reported has been resolved.",
  closed: "Your report has been closed after resolution.",
};

// FIX — this is the piece that was completely missing: changing a
// report's status here updated `citizen_reports` and nothing else. The
// resident had no way to know unless they happened to reopen the app
// and pull up that specific report. Inserting into `notifications`
// makes the update reach them two ways: (1) instantly, if their phone's
// NotificationsProvider realtime subscription is live, and (2) via an
// actual push notification if a Supabase Database Webhook is wired to
// call the send-push-notification Edge Function on inserts to this
// table (see supabase/functions/send-push-notification and the
// accompanying SQL in notifications_push_setup.sql) — that function
// reads the resident's fcm_token off `profiles` and sends the FCM push
// itself, which is the part that has to happen server-side.
const notifyResidentOfReportStatus = async (report, newStatus) => {
  if (!report?.user_id) return;
  const label = report.subcategory || report.category || "Citizen Report";
  try {
    const { error } = await supabase.from("notifications").insert({
      user_id: report.user_id,
      title: `Report Update: ${label}`,
      message:
        REPORT_STATUS_MESSAGES[newStatus] ||
        `Your report status changed to "${statusLabel(newStatus)}".`,
      type: "report",
      data: { report_id: report.id, status: newStatus },
    });
    if (error) console.error("Failed to notify resident of report status change:", error);
  } catch (err) {
    // Non-fatal — the status change itself already succeeded above;
    // don't block the admin's workflow on the notification failing.
    console.error("Failed to notify resident of report status change:", err);
  }
};

const CitizenReportsPage = () => {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedReport, setSelectedReport] = useState(null);
  const [filter, setFilter] = useState("all");
  // Defaults to "High" so admins land straight on the reports that need
  // the fastest response, instead of having to filter manually every time.
  const [severityFilter, setSeverityFilter] = useState("High");
  const [search, setSearch] = useState("");

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError("");

    // Try to join the reporter's profile (name/phone) for display. If the
    // foreign-key relationship isn't set up in Supabase yet, fall back to a
    // plain select so the page still works.
    let { data, error } = await supabase
      .from("citizen_reports")
      .select("*, profiles(name, email, phone)")
      .order("created_at", { ascending: false });

    if (error) {
      ({ data, error } = await supabase
        .from("citizen_reports")
        .select("*")
        .order("created_at", { ascending: false }));
    }

    if (error) {
      setError(error.message);
    } else {
      setReports(data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  const handleStatusChange = async (id, newStatus) => {
    // Grab the full row (with user_id) before optimistically overwriting
    // it below — need it either way to know who to notify and whether
    // the status is actually changing.
    const report = reports.find((r) => r.id === id) || selectedReport;

    setReports((prev) => prev.map((r) => (r.id === id ? { ...r, status: newStatus } : r)));
    if (selectedReport?.id === id) {
      setSelectedReport((prev) => ({ ...prev, status: newStatus }));
    }
    const { error } = await supabase
      .from("citizen_reports")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      setError(error.message);
      return;
    }

    // Skip the notification if nothing actually changed (e.g. re-picking
    // the same status from the dropdown) so the resident isn't spammed
    // with duplicate "your report was updated" pushes.
    if (report && report.status !== newStatus) {
      await notifyResidentOfReportStatus(report, newStatus);
    }
  };

  const residentName = (report) =>
    report.profiles?.name || report.contact || "Resident";

  const isDone = (report) => report.status === "resolved" || report.status === "closed";

  // FIX — reports used to only ever sort by created_at, so a High
  // severity report submitted yesterday could sit buried below a dozen
  // Low severity ones from this morning — and a resolved/closed report
  // could sit ABOVE an ongoing one just for being more severe or newer,
  // burying the work that's still actually in progress. Ongoing reports
  // now always come before resolved/closed ones; within each of those
  // two groups, High severity floats to the top, then most recent first.
  const filteredReports = reports
    .filter((report) => {
      if (filter !== "all" && report.status !== filter) return false;
      if (severityFilter !== "all" && report.severity !== severityFilter) return false;
      const haystack = `${report.description || ""} ${residentName(report)} ${report.category || ""}`.toLowerCase();
      if (search && !haystack.includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      const doneDiff = Number(isDone(a)) - Number(isDone(b));
      if (doneDiff !== 0) return doneDiff;
      const severityDiff =
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
      if (severityDiff !== 0) return severityDiff;
      return new Date(b.created_at) - new Date(a.created_at);
    });

  // Index where the resolved/closed group begins, so the table can drop
  // in a section divider right at that boundary (filteredReports is
  // already sorted so all "ongoing" rows come first).
  const firstDoneIndex = filteredReports.findIndex(isDone);

  const formatDate = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("en-PH", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">
          Citizen Reports Management
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Review and manage reports submitted by residents via the mobile app
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm px-4 py-3">
          {error}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border dark:border-gray-700">
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {reports.length}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Reports</div>
        </div>
        <div
          className="bg-white dark:bg-gray-800 rounded-xl p-4 border-2 border-red-300 dark:border-red-700 cursor-pointer"
          onClick={() => setSeverityFilter("High")}
          title="Click to filter to High priority reports"
        >
          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
            {reports.filter((r) => r.severity === "High").length}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">High Priority</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border dark:border-gray-700">
          <div className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
            {reports.filter((r) => r.status === "received").length}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Awaiting Assignment</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border dark:border-gray-700">
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
            {reports.filter((r) => r.status === "in_progress" || r.status === "assigned").length}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">In Progress</div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border dark:border-gray-700">
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            {reports.filter((r) => r.status === "resolved" || r.status === "closed").length}
          </div>
          <div className="text-sm text-gray-600 dark:text-gray-400">Resolved</div>
        </div>
      </div>

      {/* Filters and Search */}
      <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border dark:border-gray-700">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start space-x-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Filter by Status
              </label>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white"
              >
                <option value="all">All Reports</option>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Filter by Severity
              </label>
              <select
                value={severityFilter}
                onChange={(e) => setSeverityFilter(e.target.value)}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white"
              >
                <option value="all">All Severities</option>
                <option value="High">High Priority</option>
                <option value="Medium">Medium Priority</option>
                <option value="Low">Low Priority</option>
              </select>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-[220px]">
                Severity is AI-suggested — always confirm before acting.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Search
              </label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search reports or residents..."
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white w-full md:w-64"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Reports Table */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm overflow-hidden border dark:border-gray-700">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Report Details
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Category
                </th>
                <th
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                  title="AI-suggested severity — requires human confirmation, not a final determination"
                >
                  Severity ⓘ
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                    Loading reports…
                  </td>
                </tr>
              )}
              {!loading && filteredReports.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-gray-500 dark:text-gray-400">
                    No reports match this view.
                  </td>
                </tr>
              )}
              {filteredReports.map((report, index) => (
                <Fragment key={report.id}>
                  {index === firstDoneIndex && index > 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-6 py-2 bg-gray-100 dark:bg-gray-900 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
                      >
                        Resolved / Closed
                      </td>
                    </tr>
                  )}
                  <tr
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                    onClick={() => setSelectedReport(report)}
                  >
                  <td className="px-6 py-4">
                    <div>
                      <div className="font-medium text-gray-800 dark:text-white">
                        {report.subcategory || report.category}
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">
                        by {residentName(report)}
                      </div>
                      <div className="text-xs text-gray-500 mt-1 truncate max-w-xs">
                        {report.location}
                      </div>
                      <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                        📱 Submitted via mobile
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-900/30 text-gray-800 dark:text-gray-300">
                      {report.category}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    {report.severity ? (
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                          severityColors[report.severity] || severityColors.Low
                        }`}
                      >
                        {report.severity}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <select
                      value={report.status || "received"}
                      onChange={(e) => handleStatusChange(report.id, e.target.value)}
                      className={`text-xs font-medium px-2 py-1 rounded-full border-0 focus:ring-2 focus:ring-offset-1 ${
                        statusColors[report.status] || statusColors.received
                      }`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {statusLabel(s)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400">
                    {formatDate(report.created_at)}
                  </td>
                  <td className="px-6 py-4 text-sm font-medium space-x-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedReport(report);
                      }}
                      className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300"
                    >
                      View
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStatusChange(report.id, "resolved");
                      }}
                      className="text-green-600 dark:text-green-400 hover:text-green-900 dark:hover:text-green-300"
                    >
                      Resolve
                    </button>
                  </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Report Detail Modal */}
      {selectedReport && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold text-gray-800 dark:text-white">
                    {selectedReport.subcategory || selectedReport.category}
                  </h3>
                  <p className="text-gray-600 dark:text-gray-400">
                    Report #{selectedReport.id?.toString().slice(0, 8)} • {formatDate(selectedReport.created_at)}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedReport(null)}
                  className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Resident
                    </label>
                    <p className="mt-1 text-gray-800 dark:text-white">
                      {residentName(selectedReport)}
                      {selectedReport.profiles?.phone && (
                        <span className="text-gray-500 text-sm"> • {selectedReport.profiles.phone}</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Location
                    </label>
                    <p className="mt-1 text-gray-800 dark:text-white">
                      {selectedReport.location}
                    </p>
                  </div>
                </div>

                {/* Map — `location` is a plain text field (see schema.sql),
                    sometimes a raw "lat, lng" string when the mobile app's
                    reverse-geocoding failed, sometimes a real address.
                    Google's public map-embed endpoint geocodes either kind
                    of query itself, so this works for both without a Maps
                    API key or billing setup. */}
                {selectedReport.location && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Map
                    </label>
                    <iframe
                      title="Report location"
                      className="w-full h-64 rounded-lg border dark:border-gray-700"
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      src={`https://www.google.com/maps?q=${encodeURIComponent(
                        selectedReport.location
                      )}&output=embed`}
                    />
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Description
                  </label>
                  <p className="mt-1 text-gray-800 dark:text-white bg-gray-50 dark:bg-gray-900/50 p-3 rounded-lg">
                    {selectedReport.description}
                  </p>
                </div>

                {Array.isArray(selectedReport.photo_urls) && selectedReport.photo_urls.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Attached Photos
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {selectedReport.photo_urls.map((url, idx) => (
                        <a key={idx} href={url} target="_blank" rel="noreferrer">
                          <img
                            src={url}
                            alt={`Report attachment ${idx + 1}`}
                            className="w-24 h-24 object-cover rounded-lg border dark:border-gray-700"
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Category
                    </label>
                    <p className="mt-1">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-900/30 text-gray-800 dark:text-gray-300">
                        {selectedReport.category}
                      </span>
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Severity
                    </label>
                    <p className="mt-1">
                      {selectedReport.severity ? (
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                            severityColors[selectedReport.severity] || severityColors.Low
                          }`}
                        >
                          {selectedReport.severity}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                      AI-suggested — requires human confirmation.
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Status
                    </label>
                    <p className="mt-1">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        statusColors[selectedReport.status] || statusColors.received
                      }`}>
                        {statusLabel(selectedReport.status)}
                      </span>
                    </p>
                  </div>
                </div>

                <div className="pt-4 border-t dark:border-gray-700">
                  <h4 className="font-medium text-gray-800 dark:text-white mb-2">
                    Update Report Status
                  </h4>
                  <select
                    value={selectedReport.status || "received"}
                    onChange={(e) => handleStatusChange(selectedReport.id, e.target.value)}
                    className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-white"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(s)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex justify-end space-x-3 pt-4 border-t dark:border-gray-700">
                  <button
                    onClick={() => setSelectedReport(null)}
                    className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-300"
                  >
                    Close
                  </button>
                  <button
                    onClick={() => {
                      handleStatusChange(selectedReport.id, "resolved");
                      setSelectedReport(null);
                    }}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg"
                  >
                    Mark as Resolved
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Integration Info */}
      <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
        <div className="flex items-center">
          <div className="flex-shrink-0">
            <span className="text-2xl">📱</span>
          </div>
          <div className="ml-3">
            <h4 className="text-sm font-medium text-green-800 dark:text-green-300">
              Mobile Reporting Integration
            </h4>
            <p className="text-sm text-green-700 dark:text-green-400">
              Residents submit reports directly through the Maylaud mobile app. Reports are
              read live from the same `citizen_reports` table — status changes made here are
              visible to the resident on their next refresh.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CitizenReportsPage;
