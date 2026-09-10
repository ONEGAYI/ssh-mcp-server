#!/usr/bin/bash
# Stage-0 probe only: checks detached execution and persisted results.
# Not a production task runner: no cancellation, quotas or startup recovery yet.
set -euo pipefail
umask 077

operation=${1:?operation is required}
root=${2:?absolute probe root is required}
job_id=${3:?job id is required}
case "$root" in /*) ;; *) printf 'root must be absolute\n' >&2; exit 2 ;; esac
[[ "$root" != / && "$job_id" =~ ^[A-Za-z0-9_-]+$ ]] || exit 2
job="$root/$job_id"

process_identity() {
  local pid=$1 raw rest
  local -a fields
  [[ -r "/proc/$pid/stat" ]] || return 1
  raw=$(< "/proc/$pid/stat")
  rest=${raw##*) }
  read -r -a fields <<< "$rest"
  [[ ${fields[0]:-Z} != Z && ${fields[0]:-X} != X ]] || return 1
  printf '%s:%s\n' "$(< /proc/sys/kernel/random/boot_id)" "${fields[19]}"
}

case "$operation" in
  start)
    command=${4:?command is required}
    mkdir -p -- "$root"
    mkdir -- "$job"
    printf '%s\n' "$command" > "$job/command.sh"
    script=$(readlink -f -- "$0")
    # CentOS 7's util-linux 2.23 setsid has no --fork/-f option.
    nohup setsid /usr/bin/bash "$script" worker "$root" "$job_id" </dev/null >"$job/launcher.log" 2>&1 &
    printf 'jobId=%s\n' "$job_id"
    ;;
  worker)
    trap '' HUP
    cd -- "$job"
    printf '%s\n' "$$" > worker-pid
    process_identity "$$" > worker-identity
    : > running
    set +e
    /usr/bin/bash ./command.sh </dev/null >stdout 2>stderr
    code=$?
    set -e
    printf '%s\n' "$code" > exit-code.tmp
    mv -- exit-code.tmp exit-code
    ;;
  inspect)
    if [[ -f "$job/exit-code" ]]; then
      printf 'state=exited\nexitCode=%s\n' "$(< "$job/exit-code")"
    elif [[ -f "$job/running" && -f "$job/worker-identity" ]] && \
         current=$(process_identity "$(< "$job/worker-pid")") && \
         [[ "$current" == "$(< "$job/worker-identity")" ]]; then
      printf 'state=running\n'
    else
      printf 'state=unknown\n'
    fi
    ;;
  *) printf 'unsupported operation\n' >&2; exit 2 ;;
esac
