import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, PencilLine, RefreshCcw, Tag, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Main } from '@/components/layout/main'
import { derpKeys, listDerp } from '@/features/derp/data/derp-api'
import {
  deleteNode,
  derpNameSet,
  expireNode,
  fetchMachines,
  type HsMachine,
  hsKeys,
  isDerpNode,
  renameNode,
  setNodeTags,
  userName,
} from '@/features/headscale/hs-api'

// ─── Dialogs ─────────────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  description,
  onConfirm,
  onClose,
  loading,
}: {
  open: boolean
  title: string
  description: string
  onConfirm: () => void
  onClose: () => void
  loading?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>{description}</p>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={loading}>
            Huỷ
          </Button>
          <Button variant='destructive' onClick={onConfirm} disabled={loading}>
            {loading ? 'Đang xử lý…' : 'Xác nhận'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RenameDialog({
  open,
  node,
  onClose,
}: {
  open: boolean
  node: HsMachine | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(node?.givenName || node?.name || '')
  const mut = useMutation({
    mutationFn: () => renameNode(node!.id!, name.trim()),
    onSuccess: () => {
      toast.success('Đã đổi tên node')
      void qc.invalidateQueries({ queryKey: hsKeys.machines })
      onClose()
    },
    onError: (e: Error) => toast.error(`Lỗi: ${e.message}`),
  })
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đổi tên node</DialogTitle>
        </DialogHeader>
        <div className='space-y-2'>
          <Label>Tên mới</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={mut.isPending}>
            Huỷ
          </Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !name.trim()}
          >
            {mut.isPending ? 'Đang lưu…' : 'Lưu'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TagsDialog({
  open,
  node,
  onClose,
}: {
  open: boolean
  node: HsMachine | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const existing = [...(node?.validTags ?? []), ...(node?.forcedTags ?? [])]
  const [raw, setRaw] = useState(existing.join(', '))
  const mut = useMutation({
    mutationFn: () => {
      const tags = raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      return setNodeTags(node!.id!, tags)
    },
    onSuccess: () => {
      toast.success('Đã cập nhật tags')
      void qc.invalidateQueries({ queryKey: hsKeys.machines })
      onClose()
    },
    onError: (e: Error) => toast.error(`Lỗi: ${e.message}`),
  })
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đặt tags cho node</DialogTitle>
        </DialogHeader>
        <div className='space-y-2'>
          <Label>Tags (phân cách bằng dấu phẩy, dạng tag:xxx)</Label>
          <Input
            placeholder='tag:server, tag:prod'
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={mut.isPending}>
            Huỷ
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? 'Đang lưu…' : 'Lưu'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Row action menu ──────────────────────────────────────────────────────────

type Action = 'delete' | 'expire' | 'rename' | 'tags'

function NodeActions({
  node,
  onAction,
}: {
  node: HsMachine
  onAction: (action: Action, node: HsMachine) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' className='h-8 w-8'>
          <MoreHorizontal className='h-4 w-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuItem onClick={() => onAction('rename', node)}>
          <PencilLine className='mr-2 h-4 w-4' />
          Đổi tên
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('tags', node)}>
          <Tag className='mr-2 h-4 w-4' />
          Đặt tags
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('expire', node)}>
          <RefreshCcw className='mr-2 h-4 w-4' />
          Expire key
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className='text-destructive focus:text-destructive'
          onClick={() => onAction('delete', node)}
        >
          <Trash2 className='mr-2 h-4 w-4' />
          Xoá node
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ─── Table ────────────────────────────────────────────────────────────────────

function MachineRow({
  n,
  onAction,
}: {
  n: HsMachine
  onAction: (action: Action, node: HsMachine) => void
}) {
  const tags = [...(n.validTags ?? []), ...(n.forcedTags ?? [])]
  return (
    <TableRow>
      <TableCell className='font-medium'>
        {n.givenName || n.name || '—'}
        {tags.length > 0 && (
          <div className='mt-0.5 flex flex-wrap gap-1'>
            {tags.map((t) => (
              <span
                key={t}
                className='rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground'
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className='text-xs text-muted-foreground'>{userName(n.user)}</TableCell>
      <TableCell className='font-mono text-xs'>{n.ipAddresses?.[0] ?? '—'}</TableCell>
      <TableCell>
        {n.online ? (
          <Badge
            variant='outline'
            className='border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
          >
            <span className='me-1 inline-block size-2 rounded-full bg-emerald-500' />
            Connected
          </Badge>
        ) : (
          <Badge
            variant='outline'
            className='border-muted-foreground/30 text-muted-foreground'
          >
            <span className='me-1 inline-block size-2 rounded-full bg-muted-foreground' />
            offline
          </Badge>
        )}
      </TableCell>
      <TableCell className='text-xs text-muted-foreground'>
        {n.lastSeen ? new Date(n.lastSeen).toLocaleString() : '—'}
      </TableCell>
      <TableCell className='text-right'>
        <NodeActions node={n} onAction={onAction} />
      </TableCell>
    </TableRow>
  )
}

function MachineTable({
  rows,
  onAction,
}: {
  rows: HsMachine[]
  onAction: (action: Action, node: HsMachine) => void
}) {
  return (
    <div className='overflow-hidden rounded-md border'>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tên</TableHead>
            <TableHead>User</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>Trạng thái</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className='h-16 text-center text-muted-foreground'>
                Không có node nào.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((n, i) => (
              <MachineRow key={n.id ?? i} n={n} onAction={onAction} />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function Machines() {
  const qc = useQueryClient()
  const { data, isLoading, isError } = useQuery({
    queryKey: hsKeys.machines,
    queryFn: fetchMachines,
    refetchInterval: 30_000,
  })
  const derp = useQuery({ queryKey: derpKeys.all, queryFn: listDerp })

  const [dialog, setDialog] = useState<{ action: Action; node: HsMachine } | null>(null)
  const close = () => setDialog(null)

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteNode(id),
    onSuccess: () => {
      toast.success('Đã xoá node')
      void qc.invalidateQueries({ queryKey: hsKeys.machines })
      close()
    },
    onError: (e: Error) => toast.error(`Lỗi: ${e.message}`),
  })

  const expireMut = useMutation({
    mutationFn: (id: string) => expireNode(id),
    onSuccess: () => {
      toast.success('Đã expire key node — node sẽ cần xác thực lại')
      void qc.invalidateQueries({ queryKey: hsKeys.machines })
      close()
    },
    onError: (e: Error) => toast.error(`Lỗi: ${e.message}`),
  })

  const names = derpNameSet(derp.data ?? [])
  const nodes = data?.nodes ?? []
  const userNodes = nodes
    .filter((n) => !isDerpNode(n.givenName || n.name, names))
    .sort((a, b) => Number(b.online) - Number(a.online))
  const derpNodes = nodes
    .filter((n) => isDerpNode(n.givenName || n.name, names))
    .sort((a, b) => Number(b.online) - Number(a.online))

  const handleAction = (action: Action, node: HsMachine) => {
    setDialog({ action, node })
  }

  return (
    <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Machines</h2>
        <p className='text-muted-foreground'>
          Thiết bị tailnet — tách thiết bị người dùng và node DERP. Tự làm mới 30s.
        </p>
      </div>

      {isError ? (
        <ErrorBox />
      ) : isLoading ? (
        <p className='text-sm text-muted-foreground'>Đang tải…</p>
      ) : !data?.configured ? (
        <NotConfigured />
      ) : (
        <Tabs defaultValue='users'>
          <TabsList>
            <TabsTrigger value='users'>
              Thiết bị người dùng
              <span className='ms-1.5 text-muted-foreground'>({userNodes.length})</span>
            </TabsTrigger>
            <TabsTrigger value='derp'>
              Node DERP / hạ tầng
              <span className='ms-1.5 text-muted-foreground'>({derpNodes.length})</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value='users' className='mt-4'>
            <MachineTable rows={userNodes} onAction={handleAction} />
          </TabsContent>
          <TabsContent value='derp' className='mt-4'>
            <MachineTable rows={derpNodes} onAction={handleAction} />
          </TabsContent>
        </Tabs>
      )}

      {/* Confirm delete */}
      <ConfirmDialog
        open={dialog?.action === 'delete'}
        title='Xoá node'
        description={`Xoá "${dialog?.node?.givenName || dialog?.node?.name}"? Thiết bị sẽ bị ngắt khỏi tailnet và cần đăng ký lại.`}
        onConfirm={() => dialog?.node?.id && deleteMut.mutate(dialog.node.id)}
        onClose={close}
        loading={deleteMut.isPending}
      />

      {/* Confirm expire */}
      <ConfirmDialog
        open={dialog?.action === 'expire'}
        title='Expire key node'
        description={`Node "${dialog?.node?.givenName || dialog?.node?.name}" sẽ phải xác thực lại lần sau.`}
        onConfirm={() => dialog?.node?.id && expireMut.mutate(dialog.node.id)}
        onClose={close}
        loading={expireMut.isPending}
      />

      {/* Rename */}
      <RenameDialog
        open={dialog?.action === 'rename'}
        node={dialog?.node ?? null}
        onClose={close}
      />

      {/* Tags */}
      <TagsDialog
        open={dialog?.action === 'tags'}
        node={dialog?.node ?? null}
        onClose={close}
      />
    </Main>
  )
}

export function NotConfigured() {
  return (
    <div className='rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm'>
      Chưa cấu hình <span className='font-mono'>HEADSCALE_API_KEY</span> trên server.
    </div>
  )
}

export function ErrorBox() {
  return (
    <div className='rounded-md border border-destructive/40 p-4 text-sm text-destructive'>
      Không gọi được Headscale API (kiểm tra key / kết nối tới headscale:8080).
    </div>
  )
}
