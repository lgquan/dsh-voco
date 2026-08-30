import { useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { VocoSettingsFace } from './voco-settings-controller.ts'
import css from './VocoSettingsCard.module.css'

export type VocoSettingsCardProps =
  PropsRuntime<'settings.plugin.item'> & PropsLocale<'voice'> & InjectFace<VocoSettingsFace>

/** Official plugin-settings slot contribution for the Voco credential. */
export function VocoSettingsCard({ useVocoSettings, editApiKey, save, discard, t }: VocoSettingsCardProps) {
  const [open, setOpen] = useState(false)
  const state = useVocoSettings(value => value)
  if (!state.available) return null
  const title = t('settings.title')
  const disabled = !state.writable || !state.apiKeyWritable || state.saving
  const saveDisabled = !state.dirty || disabled

  return (
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {state.dirty && <span className={css.pending}>{t('settings.unsaved')}</span>}
        <IconChevronDownOutline14 className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
      </button>
      {open && (
        <div className={css.body}>
          {!state.writable && <p className={css.readOnly} role="status">{t('settings.readOnly')}</p>}
          <div className={css.field}>
            <div className={css.fieldHead}>
              <label className={css.label} htmlFor="voco-siliconflow-api-key">
                {t('settings.apiKey')}
              </label>
              <span className={state.apiKeyConfigured ? css.badge : css.badgeMuted}>
                {t(state.apiKeyConfigured ? 'settings.apiKeySet' : 'settings.apiKeyUnset')}
              </span>
            </div>
            <input
              id="voco-siliconflow-api-key"
              className={css.input}
              type="password"
              autoComplete="off"
              value={state.apiKey}
              disabled={disabled}
              onChange={event => { editApiKey(event.target.value) }}
            />
            <p className={css.hint}>{t('settings.apiKeyHint')}</p>
            <dl className={css.providerDetails}>
              <div className={css.providerDetail}>
                <dt>{t('settings.platform')}</dt>
                <dd>{t('settings.platformValue')}</dd>
              </div>
              <div className={css.providerDetail}>
                <dt>{t('settings.model')}</dt>
                <dd>{t('settings.modelValue')}</dd>
              </div>
            </dl>
          </div>
          <div className={css.footer}>
            {state.failed && <p className={css.failed} role="status">{t('settings.saveFailed')}</p>}
            <button
              type="button"
              className={css.discard}
              disabled={!state.dirty || state.saving}
              onClick={discard}
            >
              {t('settings.discard')}
            </button>
            <button type="button" className={css.save} disabled={saveDisabled} onClick={save}>
              {t(state.saving ? 'settings.saving' : 'settings.save')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
