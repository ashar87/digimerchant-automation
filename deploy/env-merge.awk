# Used by push.sh to update the server .env:  awk -f env-merge.awk server.env local.env
# The local file wins, except that a key set (non-empty) only on the server, or
# blank locally, keeps its server value: secrets put there with set-secret.sh.
FNR == NR {
  if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/) && length($0) > RLENGTH) old[substr($0, 1, RLENGTH - 1)] = substr($0, RLENGTH + 1)
  next
}
{
  if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
    k = substr($0, 1, RLENGTH - 1); seen[k] = 1
    if (length($0) == RLENGTH && (k in old)) { print k "=" old[k]; next }
  }
  print
}
END { for (k in old) if (!(k in seen)) print k "=" old[k] }
