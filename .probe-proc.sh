p=194
echo "== cmdline:"; tr '\0' ' ' < /proc/$p/cmdline 2>&1; echo
echo "== exe: $(readlink /proc/$p/exe 2>&1)"
echo "== cwd: $(readlink /proc/$p/cwd 2>&1)"
echo "== cgroup:"; cat /proc/$p/cgroup 2>&1 | head -5
echo "== ppid chain:"
q=$p; for i in 1 2 3 4 5; do
  [ -e /proc/$q/stat ] || break
  read -r _ comm _ ppid rest < /proc/$q/stat
  echo "  pid=$q comm=$comm ppid=$ppid"
  q=$ppid; [ "$q" = 0 ] && break
done
echo "== start time / uptime:"; ps -o pid,lstart,etime,args -p $p 2>&1 | head -3
echo "== user units running:"; systemctl --user list-units --type=service --state=running --no-pager --plain --no-legend 2>&1 | head -10
