import * as React from 'react';
import { Command as Cmdk } from 'cmdk';
import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';

// Each wrapper takes exactly the cmdk primitive's props (minus ref) and
// forwards its ref to the primitive's element, adding only the look.
type PropsOf<T extends React.ElementType> = React.ComponentPropsWithoutRef<T>;
type RefOf<T extends React.ElementType> = React.ComponentRef<T>;

export const Command = React.forwardRef<RefOf<typeof Cmdk>, PropsOf<typeof Cmdk>>(
  function Command({ className, ...rest }, ref) {
    return <Cmdk ref={ref} className={cn('flex flex-col', className)} {...rest} />;
  },
);
Command.displayName = Cmdk.displayName;

export const CommandInput = React.forwardRef<RefOf<typeof Cmdk.Input>, PropsOf<typeof Cmdk.Input>>(
  function CommandInput({ className, ...rest }, ref) {
    return (
      <div className="flex items-center border-b border-foreground/10 px-3">
        <Search aria-hidden className="mr-2 h-3.5 w-3.5 shrink-0 text-foreground/50" />
        <Cmdk.Input
          ref={ref}
          className={cn(
            'flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none',
            'placeholder:text-foreground/45 disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...rest}
        />
      </div>
    );
  },
);
CommandInput.displayName = Cmdk.Input.displayName;

export const CommandList = React.forwardRef<RefOf<typeof Cmdk.List>, PropsOf<typeof Cmdk.List>>(
  function CommandList({ className, ...rest }, ref) {
    return (
      <Cmdk.List
        ref={ref}
        className={cn('max-h-[340px] overflow-x-hidden overflow-y-auto p-1.5 [scrollbar-width:thin]', className)}
        {...rest}
      />
    );
  },
);
CommandList.displayName = Cmdk.List.displayName;

export const CommandEmpty = React.forwardRef<RefOf<typeof Cmdk.Empty>, PropsOf<typeof Cmdk.Empty>>(
  function CommandEmpty(props, ref) {
    return <Cmdk.Empty ref={ref} className="py-6 text-center text-sm text-muted-foreground" {...props} />;
  },
);
CommandEmpty.displayName = Cmdk.Empty.displayName;

const GROUP_HEADING =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 ' +
  '[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase ' +
  '[&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-foreground/45';

export const CommandGroup = React.forwardRef<RefOf<typeof Cmdk.Group>, PropsOf<typeof Cmdk.Group>>(
  function CommandGroup({ className, ...rest }, ref) {
    return (
      <Cmdk.Group ref={ref} className={cn('overflow-hidden text-foreground', GROUP_HEADING, className)} {...rest} />
    );
  },
);
CommandGroup.displayName = Cmdk.Group.displayName;

export const CommandItem = React.forwardRef<RefOf<typeof Cmdk.Item>, PropsOf<typeof Cmdk.Item>>(
  function CommandItem({ className, ...rest }, ref) {
    return (
      <Cmdk.Item
        ref={ref}
        className={cn(
          'relative flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[13px] outline-none select-none',
          'data-[selected=true]:bg-foreground/5 data-[selected=true]:text-foreground',
          'data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50',
          className,
        )}
        {...rest}
      />
    );
  },
);
CommandItem.displayName = Cmdk.Item.displayName;

export const CommandSeparator = React.forwardRef<RefOf<typeof Cmdk.Separator>, PropsOf<typeof Cmdk.Separator>>(
  function CommandSeparator({ className, ...rest }, ref) {
    return <Cmdk.Separator ref={ref} className={cn('-mx-1.5 h-px bg-foreground/10', className)} {...rest} />;
  },
);
CommandSeparator.displayName = Cmdk.Separator.displayName;
