import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MoreHorizontal, PencilLine, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
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
import { Main } from '@/components/layout/main'
import {
  createUser,
  deleteUser,
  fetchHsUsers,
  type HsUser,
  hsKeys,
  renameUser,
} from '@/features/headscale/hs-api'
import { ErrorBox, NotConfigured } from '@/features/machines'

// ─── Dialogs ─────────────────────────────────────────────────────────────────

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const mut = useMutation({
    mutationFn: () => createUser(name.trim()),
    onSuccess: () => {
      toast.success(`Đã tạo user "${name.trim()}"`)
      void qc.invalidateQueries({ queryKey: hsKeys.users })
      setName('')
      onClose()
    },
    onError: (e: Error) => toast.error(`Lỗi: ${e.message}`),
  })
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setName(''); onClose() } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tạo user mới</DialogTitle>
        </DialogHeader>
        <div className='space-y-2'>
          <Label>Tên user</Label>
          <Input
            placeholder='alice'
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && mut.mutate()}
          />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={mut.isPending}>
            Huỷ
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !name.trim()}>
            {mut.isPending ? 'Đang tạo…' : 'Tạo'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RenameUserDialog({
  open,
  user,
  onClose,
}: {
  open: boolean
  user: HsUser | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState(user?.name ?? '')
  const mut = useMutation({
    mutationFn: () => renameUser(user!.name!, newName.trim()),
    onSuccess: () => {
      toast.success('Đã đổi tên user')
      void qc.invalidateQueries({ queryKey: hsKeys.users })
      onClose()
    },
    onError: (e: Error) => toast.error(`Lỗi: ${e.message}`),
  })
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đổi tên user</DialogTitle>
        </DialogHeader>
        <div className='space-y-2'>
          <Label>Tên mới</Label>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && newName.trim() && mut.mutate()}
          />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={mut.isPending}>
            Huỷ
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending || !newName.trim()}>
            {mut.isPending ? 'Đang lưu…' : 'Lưu'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DeleteUserDialog({
  open,
  user,
  onClose,
}: {
  open: boolean
  user: HsUser | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const mut = useMutation({
    mutationFn: () => deleteUser(user!.name!),
    onSuccess: () => {
      toast.success(`Đã xoá user "${user?.name}"`)
      void qc.invalidateQueries({ queryKey: hsKeys.users })
      onClose()
    },
    onError: (e: Error) => toast.error(`Lỗi: ${e.message}`),
  })
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Xoá user</DialogTitle>
        </DialogHeader>
        <p className='text-sm text-muted-foreground'>
          Xoá user <strong>{user?.name}</strong>? Tất cả node của user này sẽ bị ảnh hưởng.
        </p>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={mut.isPending}>
            Huỷ
          </Button>
          <Button variant='destructive' onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? 'Đang xoá…' : 'Xoá'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Action = 'rename' | 'delete'

export function TailnetUsers() {
  const { data, isLoading, isError } = useQuery({
    queryKey: hsKeys.users,
    queryFn: fetchHsUsers,
    refetchInterval: 30_000,
  })

  const [createOpen, setCreateOpen] = useState(false)
  const [dialog, setDialog] = useState<{ action: Action; user: HsUser } | null>(null)
  const close = () => setDialog(null)

  return (
    <Main className='flex flex-1 flex-col gap-4 sm:gap-6'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Users</h2>
          <p className='text-muted-foreground'>
            Người dùng trong tailnet (DERP-Controller API).
          </p>
        </div>
        <Button size='sm' onClick={() => setCreateOpen(true)}>
          <Plus className='mr-2 h-4 w-4' />
          Tạo user
        </Button>
      </div>

      {isError ? (
        <ErrorBox />
      ) : isLoading ? (
        <p className='text-sm text-muted-foreground'>Đang tải…</p>
      ) : !data?.configured ? (
        <NotConfigured />
      ) : (
        <div className='overflow-hidden rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên</TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Tạo lúc</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className='h-24 text-center text-muted-foreground'>
                    Không có user nào.
                  </TableCell>
                </TableRow>
              ) : (
                data.users.map((u, i) => (
                  <TableRow key={u.id ?? i}>
                    <TableCell className='font-medium'>{u.name ?? '—'}</TableCell>
                    <TableCell className='font-mono text-xs'>{u.id ?? '—'}</TableCell>
                    <TableCell className='text-xs text-muted-foreground'>
                      {u.createdAt ? new Date(u.createdAt).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell className='text-right'>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant='ghost' size='icon' className='h-8 w-8'>
                            <MoreHorizontal className='h-4 w-4' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem onClick={() => setDialog({ action: 'rename', user: u })}>
                            <PencilLine className='mr-2 h-4 w-4' />
                            Đổi tên
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className='text-destructive focus:text-destructive'
                            onClick={() => setDialog({ action: 'delete', user: u })}
                          >
                            <Trash2 className='mr-2 h-4 w-4' />
                            Xoá
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateUserDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <RenameUserDialog
        open={dialog?.action === 'rename'}
        user={dialog?.user ?? null}
        onClose={close}
      />
      <DeleteUserDialog
        open={dialog?.action === 'delete'}
        user={dialog?.user ?? null}
        onClose={close}
      />
    </Main>
  )
}
