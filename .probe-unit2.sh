echo "== system unit file resolution:"
systemctl show dsh-web.service --property=FragmentPath,UnitFileState,ActiveState,SubState,MainPID,ExecStart,User,Restart 2>&1 | head -12
echo "== unit file:"
cat /etc/systemd/system/dsh-web.service 2>&1 | head -20
echo "== profile plugin keys:"
grep -n 'smart-dictation' ~/.dsh/profiles/web/package.json 2>&1 | head -8
echo "== keepalive processes:"
pgrep -af 'sleep 43200|wsl-keepalive' 2>&1 | head -5
