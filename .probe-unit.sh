echo "== whoami: $(whoami) uid=$(id -u)"
echo "== XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-<unset>}"
echo "== dbus: ${DBUS_SESSION_BUS_ADDRESS:-<unset>}"
echo "== units matching dsh:"
systemctl --user list-units --all --no-pager --plain --no-legend 'dsh*' 2>&1 | head -10
echo "== dsh-web.service properties:"
systemctl --user show dsh-web.service --property=Id,ActiveState,SubState,MainPID,ExecStart,WorkingDirectory 2>&1 | head -10
echo "== listening on 3080:"
ss -ltnp 2>/dev/null | grep ':3080' | head -3
