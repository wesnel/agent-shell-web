;;; agent-shell-web.el --- Web UI for agent-shell -*- lexical-binding: t; -*-

;; Copyright (C) 2026

;; Author: Wesley Nelson
;; URL: https://github.com/wesnel/agent-shell-web

;;; Commentary:
;;
;; A web-based UI for agent-shell sessions.  Provides an HTTP server
;; written in Emacs Lisp that serves a mobile-friendly SPA for
;; managing agent-shell sessions, viewing chat history, sending
;; messages, and approving/denying permission requests.
;;
;; Usage:
;;   (require 'agent-shell-web)
;;   (agent-shell-web-start)       ; Start on default port 8888
;;   (agent-shell-web-start 9999)  ; Start on custom port
;;   (agent-shell-web-stop)        ; Stop the server

;;; Code:

(require 'json)
(require 'project)
(require 'url-util)
(require 'cl-lib)
(require 'map)
(require 'seq)

;; Declare agent-shell dependencies (loaded at runtime)
(declare-function agent-shell-buffers "agent-shell")
(declare-function agent-shell--start "agent-shell")
(declare-function agent-shell--insert-to-shell-buffer "agent-shell")
(declare-function agent-shell--send-permission-response "agent-shell")
(declare-function agent-shell-subscribe-to "agent-shell")
(declare-function agent-shell-unsubscribe "agent-shell")
(declare-function agent-shell-cwd "agent-shell-project")
(declare-function agent-shell-interrupt "agent-shell")
(declare-function shell-maker-busy "shell-maker")

(defvar agent-shell-agent-configs)
(defvar agent-shell--state)

;;; --- Configuration ---

(defvar agent-shell-web--server-process nil
  "The HTTP server network process.")

(defvar agent-shell-web--port 8888
  "Port the HTTP server listens on.")

(defvar agent-shell-web--static-dir
  (expand-file-name "static" (file-name-directory (or load-file-name buffer-file-name default-directory)))
  "Directory containing static frontend files.")

(defvar agent-shell-web--max-body-size (* 1 1024 1024)
  "Maximum HTTP request body size in bytes (1MB).")

;;; --- Permission Capture ---

(defvar agent-shell-web--permission-options (make-hash-table :test 'equal)
  "Maps (buffer-name . tool-call-id) -> ACP permission options list.")

(defun agent-shell-web--capture-permission-request (orig-fn &rest args)
  "Advice to capture ACP permission request options.
Wraps ORIG-FN with ARGS, intercepting session/request_permission."
  (let* ((state (plist-get args :state))
         (acp-request (plist-get args :acp-request)))
    (when (and acp-request
               (equal (map-elt acp-request 'method) "session/request_permission"))
      (let ((buf-name (buffer-name (map-elt state :buffer)))
            (tool-call-id (map-nested-elt acp-request '(params toolCall toolCallId)))
            (options (map-nested-elt acp-request '(params options))))
        (when (and buf-name tool-call-id options)
          (puthash (cons buf-name tool-call-id) options
                   agent-shell-web--permission-options)))))
  (apply orig-fn args))

(defun agent-shell-web--cleanup-permission-response (orig-fn &rest args)
  "Advice to clean up stored permission options after response.
Wraps ORIG-FN with ARGS."
  (let ((tool-call-id (plist-get args :tool-call-id))
        (state (plist-get args :state)))
    (prog1 (apply orig-fn args)
      (when (and state tool-call-id)
        (let ((buf-name (buffer-name (map-elt state :buffer))))
          (remhash (cons buf-name tool-call-id)
                   agent-shell-web--permission-options))))))

;;; --- MIME Types ---

(defvar agent-shell-web--mime-types
  '(("html" . "text/html; charset=utf-8")
    ("css"  . "text/css; charset=utf-8")
    ("js"   . "application/javascript; charset=utf-8")
    ("json" . "application/json; charset=utf-8")
    ("png"  . "image/png")
    ("svg"  . "image/svg+xml")
    ("ico"  . "image/x-icon")
    ("webmanifest" . "application/manifest+json"))
  "Alist mapping file extensions to MIME types.")

(defun agent-shell-web--mime-type (path)
  "Return MIME type for PATH based on extension."
  (let ((ext (file-name-extension path)))
    (or (cdr (assoc ext agent-shell-web--mime-types))
        "application/octet-stream")))

;;; --- HTTP Response Helpers ---

(defun agent-shell-web--status-text (code)
  "Return HTTP status text for CODE."
  (pcase code
    (200 "OK")
    (201 "Created")
    (204 "No Content")
    (400 "Bad Request")
    (404 "Not Found")
    (405 "Method Not Allowed")
    (413 "Payload Too Large")
    (500 "Internal Server Error")
    (_ "Unknown")))

(defun agent-shell-web--respond (process status-code content-type body)
  "Send HTTP response to PROCESS with STATUS-CODE, CONTENT-TYPE, and BODY."
  (condition-case _err
      (when (and process (process-live-p process))
        (let* ((body-bytes (if (stringp body)
                               (encode-coding-string body 'utf-8)
                             body))
               (headers (format "HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nConnection: close\r\n\r\n"
                                status-code
                                (agent-shell-web--status-text status-code)
                                content-type
                                (length body-bytes))))
          (process-send-string process (concat (encode-coding-string headers 'utf-8) body-bytes))
          (delete-process process)))
    (error nil)))

(defun agent-shell-web--respond-json (process status-code data)
  "Send JSON response to PROCESS with STATUS-CODE and DATA."
  (agent-shell-web--respond process status-code "application/json; charset=utf-8"
                            (json-encode data)))

(defun agent-shell-web--respond-error (process status-code message)
  "Send error response to PROCESS with STATUS-CODE and MESSAGE."
  (agent-shell-web--respond-json process status-code
                                 `((error . ,message))))

(defun agent-shell-web--respond-file (process file-path)
  "Send static file at FILE-PATH as response to PROCESS."
  (if (file-exists-p file-path)
      (let ((content (with-temp-buffer
                       (set-buffer-multibyte nil)
                       (insert-file-contents-literally file-path)
                       (buffer-string)))
            (mime (agent-shell-web--mime-type file-path)))
        (agent-shell-web--respond process 200 mime content))
    (agent-shell-web--respond-error process 404 "Not found")))

;;; --- HTTP Request Parsing ---

(defun agent-shell-web--parse-query-string (query)
  "Parse QUERY string into an alist."
  (when (and query (not (string-empty-p query)))
    (mapcar (lambda (pair)
              (let ((parts (split-string pair "=" t)))
                (cons (url-unhex-string (car parts))
                      (if (cdr parts)
                          (url-unhex-string (cadr parts))
                        ""))))
            (split-string query "&" t))))

(defun agent-shell-web--parse-request (data)
  "Parse raw HTTP request DATA into a plist.
Returns (:method METHOD :path PATH :query-params PARAMS :headers HEADERS :body BODY)."
  (let* ((header-end (string-match "\r\n\r\n" data))
         (header-section (substring data 0 header-end))
         (body (substring data (+ header-end 4)))
         (lines (split-string header-section "\r\n"))
         (request-line (car lines))
         (request-parts (split-string request-line " "))
         (method (nth 0 request-parts))
         (raw-path (nth 1 request-parts))
         (path-parts (split-string raw-path "?" t))
         (path (url-unhex-string (car path-parts)))
         (query-string (cadr path-parts))
         (query-params (agent-shell-web--parse-query-string query-string))
         (headers (mapcar (lambda (line)
                            (when (string-match "^\\([^:]+\\): \\(.*\\)$" line)
                              (cons (downcase (match-string 1 line))
                                    (match-string 2 line))))
                          (cdr lines))))
    (list :method method
          :path path
          :query-params query-params
          :headers (delq nil headers)
          :body body)))

(defun agent-shell-web--get-content-length (data)
  "Extract Content-Length from raw HTTP request DATA, or nil."
  (when (string-match "Content-Length: \\([0-9]+\\)" data)
    (string-to-number (match-string 1 data))))

;;; --- Routing ---

(defun agent-shell-web--route (process request)
  "Route parsed REQUEST to the appropriate handler, responding on PROCESS."
  (let ((method (plist-get request :method))
        (path (plist-get request :path)))
    (condition-case err
        (cond
         ;; CORS preflight
         ((equal method "OPTIONS")
          (agent-shell-web--respond process 204 "text/plain" ""))

         ;; Static: root
         ((and (equal method "GET") (equal path "/"))
          (agent-shell-web--respond-file
           process (expand-file-name "index.html" agent-shell-web--static-dir)))

         ;; Static: /static/...
         ((and (equal method "GET") (string-prefix-p "/static/" path))
          (let* ((rel-path (substring path (length "/static/")))
                 (file-path (expand-file-name rel-path agent-shell-web--static-dir)))
            ;; Prevent path traversal
            (if (or (string-match-p "\\.\\." rel-path)
                    (not (string-prefix-p (file-truename agent-shell-web--static-dir)
                                          (file-truename file-path))))
                (agent-shell-web--respond-error process 404 "Not found")
              (agent-shell-web--respond-file process file-path))))

         ;; API: projects
         ((and (equal method "GET") (equal path "/api/projects"))
          (agent-shell-web--api-projects process request))

         ;; API: configs
         ((and (equal method "GET") (equal path "/api/configs"))
          (agent-shell-web--api-configs process request))

         ;; API: global status
         ((and (equal method "GET") (equal path "/api/status"))
          (agent-shell-web--api-status process request))

         ;; API: sessions list
         ((and (equal method "GET") (equal path "/api/sessions"))
          (agent-shell-web--api-sessions process request))

         ;; API: create session
         ((and (equal method "POST") (equal path "/api/sessions"))
          (agent-shell-web--api-session-create process request))

         ;; API: session detail (GET /api/sessions/<name>)
         ((and (equal method "GET")
               (string-match "^/api/sessions/\\([^/]+\\)$" path))
          (let ((buf-name (url-unhex-string (match-string 1 path))))
            (agent-shell-web--api-session-detail process request buf-name)))

         ;; API: session poll (GET /api/sessions/<name>/poll)
         ((and (equal method "GET")
               (string-match "^/api/sessions/\\([^/]+\\)/poll$" path))
          (let ((buf-name (url-unhex-string (match-string 1 path))))
            (agent-shell-web--api-session-poll process request buf-name)))

         ;; API: send message (POST /api/sessions/<name>/message)
         ((and (equal method "POST")
               (string-match "^/api/sessions/\\([^/]+\\)/message$" path))
          (let ((buf-name (url-unhex-string (match-string 1 path))))
            (agent-shell-web--api-session-send process request buf-name)))

         ;; API: respond permission (POST /api/sessions/<name>/permission)
         ((and (equal method "POST")
               (string-match "^/api/sessions/\\([^/]+\\)/permission$" path))
          (let ((buf-name (url-unhex-string (match-string 1 path))))
            (agent-shell-web--api-session-permission process request buf-name)))

         ;; 404
         (t (agent-shell-web--respond-error process 404 "Not found")))
      (error
       (agent-shell-web--respond-error
        process 500 (format "Internal error: %s" (error-message-string err)))))))

;;; --- Network Process Filter/Sentinel ---

(defun agent-shell-web--filter (process data)
  "Accumulate incoming DATA from client PROCESS and dispatch when complete."
  (let ((existing (or (process-get process :buffer) "")))
    (setq existing (concat existing data))
    (process-put process :buffer existing)
    ;; Check if we have complete headers
    (when (string-match "\r\n\r\n" existing)
      (let* ((header-end (+ (match-beginning 0) 4))
             (content-length (agent-shell-web--get-content-length existing)))
        (if content-length
            ;; Wait for full body
            (when (>= (length existing) (+ header-end content-length))
              (if (> content-length agent-shell-web--max-body-size)
                  (progn
                    (agent-shell-web--respond-error process 413 "Payload too large")
                    (process-put process :buffer nil))
                (let ((request (agent-shell-web--parse-request
                                (substring existing 0 (+ header-end content-length)))))
                  (process-put process :buffer nil)
                  (agent-shell-web--route process request))))
          ;; No Content-Length (GET, etc.) — dispatch immediately
          (let ((request (agent-shell-web--parse-request existing)))
            (process-put process :buffer nil)
            (agent-shell-web--route process request)))))))

(defun agent-shell-web--sentinel (process event)
  "Handle PROCESS connection EVENT."
  (when (string-match-p "\\(closed\\|connection broken\\|deleted\\)" event)
    (process-put process :buffer nil)))

;;; --- API Handlers ---

(defun agent-shell-web--api-projects (process _request)
  "Handle GET /api/projects — list known project roots."
  (let* ((roots (when (fboundp 'project-known-project-roots)
                  (project-known-project-roots)))
         (projects (mapcar (lambda (root)
                             `((root . ,root)
                               (name . ,(file-name-nondirectory
                                         (directory-file-name root)))))
                           roots)))
    (agent-shell-web--respond-json process 200
                                   `((projects . ,(vconcat projects))))))

(defun agent-shell-web--api-configs (process _request)
  "Handle GET /api/configs — list available agent configurations."
  (let* ((configs (when (boundp 'agent-shell-agent-configs)
                    agent-shell-agent-configs))
         (result (mapcar (lambda (config)
                           `((identifier . ,(symbol-name (map-elt config :identifier)))
                             (buffer_name . ,(or (map-elt config :buffer-name) ""))
                             (mode_line_name . ,(or (map-elt config :mode-line-name) ""))))
                         configs)))
    (agent-shell-web--respond-json process 200
                                   `((configs . ,(vconcat result))))))

(defun agent-shell-web--api-status (process _request)
  "Handle GET /api/status — global status of all sessions."
  (let* ((buffers (when (fboundp 'agent-shell-buffers)
                    (agent-shell-buffers)))
         (sessions
          (mapcar (lambda (buf)
                    (with-current-buffer buf
                      (let* ((state agent-shell--state)
                             (pending (agent-shell-web--pending-permission-count state)))
                        `((buffer_name . ,(buffer-name buf))
                          (busy . ,(if (agent-shell-web--shell-busy-p) t :json-false))
                          (stuck . ,(if (> pending 0) t :json-false))
                          (pending_permission_count . ,pending)))))
                  buffers)))
    (agent-shell-web--respond-json process 200
                                   `((sessions . ,(vconcat sessions))))))

(defun agent-shell-web--api-sessions (process request)
  "Handle GET /api/sessions — list running sessions."
  (let* ((query-params (plist-get request :query-params))
         (project-filter (cdr (assoc "project" query-params)))
         (buffers (when (fboundp 'agent-shell-buffers)
                    (agent-shell-buffers)))
         (filtered (if project-filter
                       (seq-filter
                        (lambda (buf)
                          (with-current-buffer buf
                            (file-equal-p project-filter (agent-shell-cwd))))
                        buffers)
                     buffers))
         (sessions
          (mapcar (lambda (buf)
                    (with-current-buffer buf
                      (let* ((state agent-shell--state)
                             (pending (agent-shell-web--pending-permission-count state)))
                        `((buffer_name . ,(buffer-name buf))
                          (project_root . ,(condition-case nil (agent-shell-cwd) (error "")))
                          (project_name . ,(file-name-nondirectory
                                            (directory-file-name
                                             (condition-case nil (agent-shell-cwd) (error default-directory)))))
                          (agent_name . ,(or (map-nested-elt state '(:agent-config :buffer-name)) ""))
                          (busy . ,(if (agent-shell-web--shell-busy-p) t :json-false))
                          (stuck . ,(if (> pending 0) t :json-false))
                          (pending_permission_count . ,pending)
                          (session_id . ,(or (map-nested-elt state '(:session :id)) :json-null))))))
                  filtered)))
    (agent-shell-web--respond-json process 200
                                   `((sessions . ,(vconcat sessions))))))

(cl-defun agent-shell-web--api-session-create (process request)
  "Handle POST /api/sessions — create a new session."
  (let* ((body (json-read-from-string (plist-get request :body)))
         (project-root (cdr (assq 'project_root body)))
         (config-id (cdr (assq 'config_identifier body)))
         (config (seq-find (lambda (c)
                             (equal (map-elt c :identifier) (intern config-id)))
                           agent-shell-agent-configs)))
    (unless config
      (agent-shell-web--respond-error process 400 "Unknown config identifier")
      (cl-return-from agent-shell-web--api-session-create))
    (unless (and project-root (file-directory-p project-root))
      (agent-shell-web--respond-error process 400 "Invalid project root")
      (cl-return-from agent-shell-web--api-session-create))
    (let* ((default-directory project-root)
           (shell-buffer (agent-shell--start
                          :config config
                          :no-focus t
                          :new-session t)))
      (agent-shell-web--respond-json process 201
                                     `((buffer_name . ,(buffer-name shell-buffer))
                                       (success . t))))))

(cl-defun agent-shell-web--api-session-detail (process _request buf-name)
  "Handle GET /api/sessions/<name> — session detail for BUF-NAME."
  (let ((buf (get-buffer buf-name)))
    (unless buf
      (agent-shell-web--respond-error process 404 "Session not found")
      (cl-return-from agent-shell-web--api-session-detail))
    (with-current-buffer buf
      (let* ((state agent-shell--state)
             (content (buffer-substring-no-properties (point-min) (point-max)))
             (pending (agent-shell-web--pending-permissions state))
             (usage (map-elt state :usage)))
        (agent-shell-web--respond-json process 200
                                       `((buffer_name . ,buf-name)
                                         (content . ,content)
                                         (busy . ,(if (agent-shell-web--shell-busy-p) t :json-false))
                                         (stuck . ,(if (> (length pending) 0) t :json-false))
                                         (session_id . ,(or (map-nested-elt state '(:session :id)) :json-null))
                                         (pending_permissions . ,(vconcat pending))
                                         (usage . ,(agent-shell-web--format-usage usage))))))))

(cl-defun agent-shell-web--api-session-poll (process _request buf-name)
  "Handle GET /api/sessions/<name>/poll — lightweight status for BUF-NAME."
  (let ((buf (get-buffer buf-name)))
    (unless buf
      (agent-shell-web--respond-error process 404 "Session not found")
      (cl-return-from agent-shell-web--api-session-poll))
    (with-current-buffer buf
      (let* ((state agent-shell--state)
             (content-length (- (point-max) (point-min)))
             (pending-count (agent-shell-web--pending-permission-count state)))
        (agent-shell-web--respond-json process 200
                                       `((busy . ,(if (agent-shell-web--shell-busy-p) t :json-false))
                                         (stuck . ,(if (> pending-count 0) t :json-false))
                                         (content_length . ,content-length)
                                         (pending_permission_count . ,pending-count)))))))

(cl-defun agent-shell-web--api-session-send (process request buf-name)
  "Handle POST /api/sessions/<name>/message — send message to BUF-NAME."
  (let ((buf (get-buffer buf-name)))
    (unless buf
      (agent-shell-web--respond-error process 404 "Session not found")
      (cl-return-from agent-shell-web--api-session-send))
    (let* ((body (json-read-from-string (plist-get request :body)))
           (text (cdr (assq 'text body))))
      (unless (and text (not (string-empty-p text)))
        (agent-shell-web--respond-error process 400 "Missing text")
        (cl-return-from agent-shell-web--api-session-send))
      (with-current-buffer buf
        (when (agent-shell-web--shell-busy-p)
          (agent-shell-web--respond-error process 409 "Session is busy")
          (cl-return-from agent-shell-web--api-session-send)))
      (agent-shell--insert-to-shell-buffer
       :shell-buffer buf
       :text text
       :submit t
       :no-focus t)
      (agent-shell-web--respond-json process 200 '((success . t))))))

(cl-defun agent-shell-web--api-session-permission (process request buf-name)
  "Handle POST /api/sessions/<name>/permission — respond to permission in BUF-NAME."
  (let ((buf (get-buffer buf-name)))
    (unless buf
      (agent-shell-web--respond-error process 404 "Session not found")
      (cl-return-from agent-shell-web--api-session-permission))
    (let* ((body (json-read-from-string (plist-get request :body)))
           (tool-call-id (cdr (assq 'tool_call_id body)))
           (option-id (cdr (assq 'option_id body)))
           (cancelled (cdr (assq 'cancelled body))))
      (unless tool-call-id
        (agent-shell-web--respond-error process 400 "Missing tool_call_id")
        (cl-return-from agent-shell-web--api-session-permission))
      (with-current-buffer buf
        (let* ((state agent-shell--state)
               (tool-call (map-elt (map-elt state :tool-calls) tool-call-id))
               (request-id (when tool-call (map-elt tool-call :permission-request-id)))
               (client (map-elt state :client))
               ;; Look up option kind BEFORE sending response (cleanup advice removes the entry)
               (options (gethash (cons buf-name tool-call-id)
                                 agent-shell-web--permission-options))
               (selected-option (when (and options option-id)
                                  (seq-find (lambda (opt) (equal (map-elt opt 'optionId) option-id)) options)))
               (is-reject (when selected-option
                            (equal (map-elt selected-option 'kind) "reject_once"))))
          (unless request-id
            (agent-shell-web--respond-error process 404 "No pending permission for this tool call")
            (cl-return-from agent-shell-web--api-session-permission))
          (agent-shell--send-permission-response
           :client client
           :request-id request-id
           :option-id (unless (eq cancelled t) option-id)
           :cancelled (when (eq cancelled t) t)
           :state state
           :tool-call-id tool-call-id
           :message-text (if (eq cancelled t)
                             "Permission cancelled via web UI"
                           (format "Permission granted via web UI: %s" option-id)))
          ;; If rejected, interrupt the agent
          (when is-reject
            (agent-shell-interrupt t))
          (agent-shell-web--respond-json process 200 '((success . t))))))))

;;; --- Helper Functions ---

(defun agent-shell-web--shell-busy-p ()
  "Return non-nil if the current buffer's shell is busy.
Must be called from within a shell buffer."
  (condition-case nil
      (shell-maker-busy)
    (error nil)))

(defun agent-shell-web--pending-permission-count (state)
  "Count pending permissions in STATE."
  (let ((count 0))
    (when-let ((tool-calls (map-elt state :tool-calls)))
      (map-do (lambda (_id tc)
                (when (map-elt tc :permission-request-id)
                  (cl-incf count)))
              tool-calls))
    count))

(defun agent-shell-web--pending-permissions (state)
  "Extract pending permission requests from STATE as a list of alists."
  (let (permissions)
    (when-let ((tool-calls (map-elt state :tool-calls)))
      (map-do
       (lambda (tool-call-id tool-call-data)
         (when-let ((request-id (map-elt tool-call-data :permission-request-id)))
           (let* ((buf-name (buffer-name (map-elt state :buffer)))
                  (options (gethash (cons buf-name tool-call-id)
                                   agent-shell-web--permission-options)))
             (push `((tool_call_id . ,tool-call-id)
                     (request_id . ,request-id)
                     (title . ,(or (map-elt tool-call-data :title) "Tool Permission"))
                     (kind . ,(or (map-elt tool-call-data :kind) ""))
                     (status . ,(or (map-elt tool-call-data :status) "pending"))
                     (options . ,(if options
                                     (vconcat
                                      (mapcar (lambda (opt)
                                                `((option_id . ,(map-elt opt 'optionId))
                                                  (name . ,(map-elt opt 'name))
                                                  (kind . ,(map-elt opt 'kind))))
                                              options))
                                   [])))
                   permissions))))
       tool-calls))
    (nreverse permissions)))

(defun agent-shell-web--format-usage (usage)
  "Format USAGE alist for JSON response."
  (when usage
    `((total_tokens . ,(or (map-elt usage :total-tokens) 0))
      (input_tokens . ,(or (map-elt usage :input-tokens) 0))
      (output_tokens . ,(or (map-elt usage :output-tokens) 0))
      (cost_amount . ,(or (map-elt usage :cost-amount) 0))
      (cost_currency . ,(or (map-elt usage :cost-currency) :json-null)))))

;;; --- Server Lifecycle ---

;;;###autoload
(defun agent-shell-web-start (&optional port)
  "Start the agent-shell-web HTTP server on PORT (default 8888)."
  (interactive "P")
  (setq agent-shell-web--port (or port 8888))
  (when agent-shell-web--server-process
    (agent-shell-web-stop))
  ;; Install advice
  (advice-add 'agent-shell--on-request :around #'agent-shell-web--capture-permission-request)
  (advice-add 'agent-shell--send-permission-response :around #'agent-shell-web--cleanup-permission-response)
  (setq agent-shell-web--server-process
        (make-network-process
         :name "agent-shell-web"
         :server t
         :host "0.0.0.0"
         :service agent-shell-web--port
         :family 'ipv4
         :filter #'agent-shell-web--filter
         :sentinel #'agent-shell-web--sentinel
         :coding 'binary
         :noquery t))
  (message "agent-shell-web server started on http://0.0.0.0:%d" agent-shell-web--port))

;;;###autoload
(defun agent-shell-web-stop ()
  "Stop the agent-shell-web HTTP server."
  (interactive)
  ;; Remove advice
  (advice-remove 'agent-shell--on-request #'agent-shell-web--capture-permission-request)
  (advice-remove 'agent-shell--send-permission-response #'agent-shell-web--cleanup-permission-response)
  ;; Clear state
  (clrhash agent-shell-web--permission-options)
  ;; Stop server
  (when agent-shell-web--server-process
    (delete-process agent-shell-web--server-process)
    (setq agent-shell-web--server-process nil))
  (message "agent-shell-web server stopped"))

(provide 'agent-shell-web)

;;; agent-shell-web.el ends here
