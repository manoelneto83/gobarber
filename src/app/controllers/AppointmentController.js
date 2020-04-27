import * as Yup from 'yup';
import { startOfHour, parseISO, isBefore, format, subHours } from 'date-fns';
import pt from 'date-fns/locale/pt';
import Appointment from '../models/Appointment';
import File from '../models/File';
import User from '../models/User';
import Notification from '../schemas/Notification';
import Queue from '../../lib/Queue';
import CancellationMail from '../jobs/CancellationMail';

class AppointmentController {
  async index(req, res) {
    const { page = 1 } = req.query;

    const appointments = await Appointment.findAll({
      where: {
        user_id: req.userId,
        canceled_at: null,
      },
      order: ['date'],
      attributes: ['id', 'date', 'past', 'cancelable'],
      limit: 20,
      offset: (page - 1) * 20,
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'name'],
          include: [
            {
              model: File,
              as: 'avatar',
              attributes: ['id', 'path', 'url'],
            },
          ],
        },
      ],
    });

    return res.json(appointments);
  }

  async store(req, res) {
    const schema = Yup.object().shape({
      provider_id: Yup.number().required(),
      date: Yup.date().required(),
    });

    if (!(await schema.isValid(req.body))) {
      return res.status(400).json({ error: 'Validation fails' });
    }

    const { provider_id, date } = req.body;

    const providerExists = await User.findOne({
      where: { id: provider_id, provider: true },
    });
    if (!providerExists) {
      return res
        .status(401)
        .json({ error: 'You can only create appointments with providers.' });
    }

    const hourStart = startOfHour(parseISO(date));
    const hourStartNow = startOfHour(new Date());

    // console.log('hourStart', hourStart);
    console.log('before', isBefore(hourStart, hourStartNow));
    console.log('hourStart', hourStart);
    console.log('atual', hourStartNow);

    if (isBefore(hourStart, hourStartNow)) {
      return res.status(400).json({ error: 'Past dates are not permited.' });
    }

    const checkAvailability = await Appointment.findOne({
      where: {
        provider_id,
        canceled_at: null,
        date: hourStart,
      },
    });

    if (checkAvailability) {
      return res
        .status(400)
        .json({ error: 'Appointment date is not available.' });
    }

    if (provider_id === req.userId) {
      return res.status(400).json({
        error: 'O usuário e prestador de serviço não pode ser a mesma pessoa.',
      });
    }

    const appointment = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date: hourStartNow,
    });

    /**
     * Notificar prestador de serviço
     */

    const user = await User.findByPk(req.userId);
    const formatDate = format(hourStart, "'dia' dd 'de' MMMM', às' H:mm'h'", {
      locale: pt,
    });

    await Notification.create({
      content: `Novo agendamento de ${user.name} para o ${formatDate}`,
      user: provider_id,
    });

    return res.json(appointment);
  }

  async update(req, res) {
    const schema = Yup.object().shape({
      name: Yup.string(),
      email: Yup.string().email(),
      oldPassword: Yup.string().min(6),
      password: Yup.string()
        .min(6)
        .when('oldPassword', (oldPassword, field) =>
          oldPassword ? field.required() : field
        ),
      confirmPassword: Yup.string().when('password', (password, field) =>
        password ? field.required().oneOf([Yup.ref('password')]) : field
      ),
    });

    if (!(await schema.isValid(req.body))) {
      return res.status(400).json({ error: 'Validation fails' });
    }

    const { email, oldPassword } = req.body;

    const user = await User.findByPk(req.userId);
    if (email !== user.email) {
      const userExists = await User.findOne({ where: { email } });
      if (userExists) {
        return res.status(400).json({ error: 'User already exists. ' });
      }
    }

    if (oldPassword && !(await user.checkPassword(oldPassword))) {
      return res.status(401).json({ error: 'Password does not match' });
    }

    const { id, name, provider } = await user.update(req.body);

    return res.json({ id, name, email, provider });
  }

  async delete(req, res) {
    const appointment = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email'],
        },
        {
          model: User,
          as: 'user',
          attributes: ['name'],
        },
      ],
    });
    console.log('aaa', appointment);
    if (appointment.user_id !== req.userId) {
      return res.status(400).json({
        error: 'Você não tem permissão para cancelar o agendamento.',
      });
    }

    const dateWithSub = subHours(appointment.created_at, 2);
    console.log('dateWithSub', dateWithSub);
    console.log('isBefore', isBefore(dateWithSub, new Date()));

    if (isBefore(dateWithSub, new Date())) {
      return res.status(401).json({
        error:
          'Você somente pode cancelar um agendamento 2 horas antes do seu horário.',
      });
    }

    appointment.canceled_at = new Date();

    await appointment.save();

    await Queue.add(CancellationMail.key, {
      appointment,
    });

    return res.json(appointment);
  }
}

export default new AppointmentController();
