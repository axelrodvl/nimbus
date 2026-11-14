import * as Ariakit from '@ariakit/react';
import { useState } from 'react';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { NumberInput } from '@/components/ui/number-input';
import { PasswordInput } from '@/components/ui/password-input';
import { ProgressBar } from '@/components/ui/progress-bar';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Sheet } from '@/components/ui/sheet';
import { SettingsRow, SettingsSection } from '@/components/ui/settings-section';
import { Slider } from '@/components/ui/slider';
import { SortableList } from '@/components/ui/sortable-list';
import { Switch } from '@/components/ui/switch';
import { Tabs } from '@/components/ui/tabs';
import { TextInput } from '@/components/ui/text-input';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * Галерея примитивов форм `/dev/ui`: все элементы во всех состояниях — для визуальной проверки и скриншотов.
 * Доступна только в dev-сборке и в сборке с `VITE_UI_GALLERY=1`; тексты здесь намеренно без i18n.
 */
export function DevUi() {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState('two');
  const [sel, setSel] = useState('b');
  const [num, setNum] = useState(8);
  const [secret, setSecret] = useState('');
  const [text, setText] = useState('Radiohead');
  const [tab, setTab] = useState('a');
  const [order, setOrder] = useState(['flac', 'alac', 'mp3_320']);
  const [slide, setSlide] = useState(0.8);
  const dialog = Ariakit.useDialogStore();
  const sheet = Ariakit.useDialogStore();
  const confirm = Ariakit.useDialogStore();
  const options = [
    { label: 'Alpha', value: 'a' },
    { label: 'Beta (a rather long option label)', value: 'b' },
    { label: 'Gamma', value: 'c' },
  ];
  return (
    <PageLayout title="UI gallery">
      <div className="flex max-w-3xl flex-col gap-6" data-testid="ui-gallery">
        <SettingsSection description="Rows with a title, description and a control" title="Settings section">
          <SettingsRow description="A short explanation of what changes" label="Switch">
            <Switch checked={on} onCheckedChange={setOn} />
          </SettingsRow>
          <SettingsRow label="Switch (disabled)">
            <Switch checked disabled onCheckedChange={() => undefined} />
          </SettingsRow>
          <SettingsRow label="Number" description="From 1 to 30">
            <NumberInput className="w-36" max={30} min={1} onCommit={setNum} unit="req/s" value={num} />
          </SettingsRow>
          <SettingsRow error="Must be between 1 and 20" label="Number (invalid)">
            <NumberInput className="w-36" max={20} min={1} onCommit={() => undefined} value={99} />
          </SettingsRow>
          <SettingsRow label="Select">
            <Select onValueChange={setSel} options={options} value={sel} />
          </SettingsRow>
          <SettingsRow label="Select (disabled)">
            <Select disabled onValueChange={() => undefined} options={options} value="a" />
          </SettingsRow>
          <SettingsRow group label="Segmented control">
            <SegmentedControl
              aria-label="Segmented control"
              onValueChange={setSeg}
              options={[
                { label: 'One', value: 'one' },
                { label: 'Two', value: 'two' },
                { label: 'Three', value: 'three' },
              ]}
              value={seg}
            />
          </SettingsRow>
          <SettingsRow label="Slider">
            <Slider max={1} min={0} onCommit={setSlide} step={0.01} value={slide} />
          </SettingsRow>
          <SettingsRow label="Text">
            <TextInput onChange={e => setText(e.target.value)} value={text} />
          </SettingsRow>
          <SettingsRow error="Required" label="Text (invalid)">
            <TextInput onChange={() => undefined} value="" />
          </SettingsRow>
          <SettingsRow label="Password (secret set)">
            <PasswordInput onValueChange={setSecret} secretSet value={secret} />
          </SettingsRow>
          <SettingsRow group label="Checkboxes">
            <div className="flex flex-wrap gap-2">
              <Checkbox checked label="Album" onCheckedChange={() => undefined} />
              <Checkbox checked={false} label="Live" onCheckedChange={() => undefined} />
              <Checkbox checked disabled label="Disabled" onCheckedChange={() => undefined} />
            </div>
          </SettingsRow>
        </SettingsSection>

        <SettingsSection title="Lists and indicators">
          <SettingsRow group label="Sortable list">
            <div className="w-full sm:w-72">
              <SortableList
                aria-label="Formats"
                items={order.map(id => ({ id, label: id.toUpperCase() }))}
                onReorder={setOrder}
              />
            </div>
          </SettingsRow>
          <SettingsRow group label="Progress">
            <div className="flex w-full flex-col gap-2 sm:w-72">
              <ProgressBar aria-label="Normal" max={100} value={40} />
              <ProgressBar aria-label="Warning" max={100} tone="warning" value={92} />
              <ProgressBar aria-label="Danger" max={100} tone="danger" value={100} />
            </div>
          </SettingsRow>
          <SettingsRow group label="Badges">
            <div className="flex flex-wrap gap-2">
              <Badge>Neutral</Badge>
              <Badge tone="success">Success</Badge>
              <Badge tone="danger">Error</Badge>
              <Badge tone="warning">Warning</Badge>
              <Badge tone="accent">Accent</Badge>
            </div>
          </SettingsRow>
          <SettingsRow group label="Tooltip">
            <Tooltip text="A helpful hint">
              <Button variant="secondary">Hover me</Button>
            </Tooltip>
          </SettingsRow>
          <SettingsRow group label="Tabs">
            <Tabs
              aria-label="Tabs"
              items={[
                { id: 'a', label: 'First' },
                { id: 'b', label: 'Second' },
                { id: 'c', label: 'Third' },
              ]}
              onSelect={setTab}
              selectedId={tab}
            />
          </SettingsRow>
          <SettingsRow group label="Dialogs">
            <div className="flex flex-wrap gap-2">
              <Button onClick={dialog.show} variant="secondary">
                Dialog
              </Button>
              <Button onClick={sheet.show} variant="secondary">
                Sheet
              </Button>
              <Button onClick={confirm.show} variant="secondary">
                Confirm
              </Button>
            </div>
          </SettingsRow>
        </SettingsSection>

        <Field
          description="Label, description and error are linked to the input"
          error="Something is wrong"
          label="Field"
        >
          <TextInput onChange={() => undefined} value="x" />
        </Field>
      </div>
      <Dialog description="Centered window" store={dialog} title="Dialog">
        <Select onValueChange={setSel} options={options} value={sel} />
      </Dialog>
      <Sheet description="Bottom panel on phones" store={sheet} title="Sheet">
        <p className="text-sm">Content</p>
      </Sheet>
      <ConfirmDialog
        confirmAction={async () => true}
        description="This is a confirmation"
        store={confirm}
        title="Confirm"
      />
    </PageLayout>
  );
}
